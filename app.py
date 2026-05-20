from flask import Flask, request, Response, render_template, stream_with_context, jsonify, redirect, url_for, session, flash
from flask_cors import CORS
from werkzeug.security import generate_password_hash, check_password_hash
from werkzeug.utils import secure_filename
from functools import wraps
from typing import List, Dict
from pathlib import Path
from groq import Groq
from PyPDF2 import PdfReader
from docx import Document
from sentence_transformers import SentenceTransformer
import mysql.connector
import faiss
import numpy as np
import json
import os
import re

app = Flask(__name__)
app.secret_key = os.getenv("SECRET_KEY", "mysecretkey123")
CORS(app, supports_credentials=True)

# =========================
# CONFIG
# =========================
GROQ_API_KEY = os.getenv("GROQ_API_KEY")
MODEL_NAME = os.getenv("MODEL_NAME", "llama-3.1-8b-instant")
client = Groq(api_key=GROQ_API_KEY) if GROQ_API_KEY else None

DB_CONFIG = {
    "host": os.getenv("DB_HOST", "localhost"),
    "user": os.getenv("DB_USER", "root"),
    "password": os.getenv("DB_PASSWORD", ""),
    "database": os.getenv("DB_NAME", "synapseai_db"),
    "port": int(os.getenv("DB_PORT", "3306")),
}

DATA_FOLDER = Path("data")
UPLOAD_FOLDER = Path("uploads")
DATA_FOLDER.mkdir(exist_ok=True)
UPLOAD_FOLDER.mkdir(exist_ok=True)
ALLOWED_EXTENSIONS = {"txt", "pdf", "docx"}

RAG_CONFIG = {
    "chunk_size": 300,
    "chunk_overlap": 80,
    "top_k": 8,
    "similarity_threshold": 0.42,
    "max_context_chunks": 4,
    "max_context_chars": 4500,
}

# =========================
# DATABASE
# =========================
def get_db():
    return mysql.connector.connect(**DB_CONFIG)


def init_db():
    """Creates required tables if they do not exist."""
    sql_statements = [
        """
        CREATE TABLE IF NOT EXISTS users (
            id INT AUTO_INCREMENT PRIMARY KEY,
            username VARCHAR(100) UNIQUE NOT NULL,
            email VARCHAR(150) UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB
        """,
        """
        CREATE TABLE IF NOT EXISTS chats (
            id INT AUTO_INCREMENT PRIMARY KEY,
            user_id INT NOT NULL,
            title VARCHAR(255) NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
            INDEX idx_chats_user_updated (user_id, updated_at)
        ) ENGINE=InnoDB
        """,
        """
        CREATE TABLE IF NOT EXISTS messages (
            id INT AUTO_INCREMENT PRIMARY KEY,
            chat_id INT NOT NULL,
            user_id INT NOT NULL,
            role ENUM('user','assistant') NOT NULL,
            content LONGTEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
            INDEX idx_messages_chat_created (chat_id, created_at),
            INDEX idx_messages_user (user_id)
        ) ENGINE=InnoDB
        """,
        """
        CREATE TABLE IF NOT EXISTS uploaded_files (
            id INT AUTO_INCREMENT PRIMARY KEY,
            user_id INT NOT NULL,
            chat_id INT,
            original_filename VARCHAR(255) NOT NULL,
            stored_filename VARCHAR(255) NOT NULL,
            file_path TEXT NOT NULL,
            uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE SET NULL,
            INDEX idx_uploaded_files_user (user_id),
            INDEX idx_uploaded_files_chat (chat_id)
        ) ENGINE=InnoDB
        """,
    ]
    try:
        db = get_db()
        cur = db.cursor()
        for stmt in sql_statements:
            cur.execute(stmt)
        db.commit()
        cur.close()
        db.close()
        print("✅ Database tables ready")
    except Exception as e:
        print(f"⚠️ Database init skipped/failed: {e}")


def login_required(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        if "user_id" not in session:
            if request.path.startswith("/api") or request.path in ["/chat", "/upload"]:
                return jsonify({"error": "Unauthorized"}), 401
            return redirect(url_for("login"))
        return fn(*args, **kwargs)
    return wrapper


def user_owns_chat(chat_id: int, user_id: int) -> bool:
    """Check if user owns the chat (DATA ISOLATION)"""
    db = get_db()
    cur = db.cursor(dictionary=True)
    cur.execute("SELECT id FROM chats WHERE id=%s AND user_id=%s", (chat_id, user_id))
    row = cur.fetchone()
    cur.close()
    db.close()
    return row is not None


def create_chat_db(user_id: int, title: str) -> int:
    """Create a new chat for the user (DATA ISOLATION: user_id)"""
    title = (title or "New Chat").strip()[:255]
    db = get_db()
    cur = db.cursor()
    cur.execute("INSERT INTO chats (user_id, title) VALUES (%s, %s)", (user_id, title))
    db.commit()
    chat_id = cur.lastrowid
    cur.close()
    db.close()
    return chat_id


def save_message_db(chat_id: int, user_id: int, role: str, content: str):
    """Save message to database (DATA ISOLATION: user_id validation)"""
    db = get_db()
    cur = db.cursor()
    cur.execute(
        "INSERT INTO messages (chat_id, user_id, role, content) VALUES (%s, %s, %s, %s)",
        (chat_id, user_id, role, content),
    )
    cur.execute("UPDATE chats SET updated_at=CURRENT_TIMESTAMP WHERE id=%s AND user_id=%s", (chat_id, user_id))
    db.commit()
    cur.close()
    db.close()


def get_chat_history_db(chat_id: int, user_id: int, limit: int = 8) -> List[Dict[str, str]]:
    """Get chat history (DATA ISOLATION: checks user owns chat)"""
    db = get_db()
    cur = db.cursor(dictionary=True)
    cur.execute(
        """
        SELECT m.role, m.content FROM messages m
        JOIN chats c ON m.chat_id = c.id
        WHERE m.chat_id=%s AND c.user_id=%s AND m.user_id=%s
        ORDER BY m.created_at DESC, m.id DESC
        LIMIT %s
        """,
        (chat_id, user_id, user_id, limit),
    )
    rows = cur.fetchall()[::-1]
    cur.close()
    db.close()
    return [{"role": "assistant" if r["role"] == "assistant" else "user", "content": r["content"]} for r in rows]


def save_uploaded_file_db(user_id: int, chat_id: int, original_filename: str, stored_filename: str, file_path: str):
    """Save uploaded file metadata (DATA ISOLATION: user_id)"""
    db = get_db()
    cur = db.cursor()
    cur.execute(
        "INSERT INTO uploaded_files (user_id, chat_id, original_filename, stored_filename, file_path) VALUES (%s, %s, %s, %s, %s)",
        (user_id, chat_id, original_filename, stored_filename, file_path),
    )
    db.commit()
    cur.close()
    db.close()


# =========================
# RAG SYSTEM
# =========================
documents: List[Dict[str, str]] = []
faiss_index = None
embedding_model = SentenceTransformer("all-MiniLM-L6-v2")


def allowed_file(filename: str) -> bool:
    return "." in filename and filename.rsplit(".", 1)[1].lower() in ALLOWED_EXTENSIONS


def clean_text(text: str) -> str:
    text = re.sub(r"\s+", " ", text or "")
    return text.strip()


def read_file(path: Path) -> str:
    text = ""
    suffix = path.suffix.lower()
    if suffix == ".txt":
        text = path.read_text(encoding="utf-8", errors="ignore")
    elif suffix == ".pdf":
        reader = PdfReader(str(path))
        for page in reader.pages:
            text += (page.extract_text() or "") + "\n"
    elif suffix == ".docx":
        doc = Document(str(path))
        text = "\n".join(p.text for p in doc.paragraphs if p.text.strip())
    return clean_text(text)


def chunk_text(text: str, source: str, doc_type: str) -> List[Dict[str, str]]:
    words = text.split()
    if not words:
        return []
    chunk_size = RAG_CONFIG["chunk_size"]
    overlap = RAG_CONFIG["chunk_overlap"]
    step = max(1, chunk_size - overlap)
    chunks = []
    for start in range(0, len(words), step):
        chunk = " ".join(words[start:start + chunk_size]).strip()
        if chunk:
            chunks.append({"text": chunk, "source": source, "type": doc_type})
        if start + chunk_size >= len(words):
            break
    return chunks


def load_documents_from_folder(folder: Path, doc_type: str) -> List[Dict[str, str]]:
    loaded = []
    if not folder.exists():
        return loaded
    for path in folder.iterdir():
        if not path.is_file() or path.suffix.lower().replace(".", "") not in ALLOWED_EXTENSIONS:
            continue
        try:
            text = read_file(path)
            chunks = chunk_text(text, path.name, doc_type)
            loaded.extend(chunks)
            print(f"✅ Loaded ({doc_type}): {path.name} ({len(chunks)} chunks)")
        except Exception as e:
            print(f"❌ Failed loading {path.name}: {e}")
    return loaded


def reload_rag():
    global documents, faiss_index
    print("🔄 Reloading RAG system...")
    documents = []
    documents.extend(load_documents_from_folder(DATA_FOLDER, "system"))
    documents.extend(load_documents_from_folder(UPLOAD_FOLDER, "user"))

    if not documents:
        faiss_index = None
        print("⚠️ No RAG documents found")
        return

    texts = [d["text"] for d in documents]
    embeddings = embedding_model.encode(texts, convert_to_numpy=True, normalize_embeddings=True, show_progress_bar=False)
    index = faiss.IndexFlatIP(embeddings.shape[1])
    index.add(embeddings.astype("float32"))
    faiss_index = index
    print(f"✅ RAG Ready: {len(documents)} chunks")


def retrieve_documents(query: str) -> List[Dict[str, str]]:
    if faiss_index is None or not documents:
        return []
    q = embedding_model.encode([query], convert_to_numpy=True, normalize_embeddings=True)
    scores, indices = faiss_index.search(q.astype("float32"), RAG_CONFIG["top_k"])
    results = []
    for idx, score in zip(indices[0], scores[0]):
        if 0 <= idx < len(documents) and score >= RAG_CONFIG["similarity_threshold"]:
            item = dict(documents[idx])
            item["score"] = float(score)
            results.append(item)
    return results[:RAG_CONFIG["max_context_chunks"]]


def build_ai_messages(user_message: str, chat_id: int, user_id: int):
    chunks = retrieve_documents(user_message)
    context = "\n\n---\n\n".join([f"[Source: {c['source']}]\n{c['text']}" for c in chunks])
    context = context[:RAG_CONFIG["max_context_chars"]]
    user_sources = []
    seen = set()
    for c in chunks:
        if c.get("type") == "user" and c["source"] not in seen:
            user_sources.append(c["source"])
            seen.add(c["source"])

    history = get_chat_history_db(chat_id, user_id, limit=8)
    messages = [{
        "role": "system",
        "content": (
            "You are SynapseAI, a helpful AI assistant. Use provided context if it is relevant. "
            "If context is unrelated, ignore it and answer normally. Give accurate, structured answers. "
            "Do not mention sources inside the answer; sources will be appended separately."
        )
    }]
    messages.extend(history)
    messages.append({
        "role": "user",
        "content": f"CONTEXT:\n{context}\n\nQUESTION:\n{user_message}" if context else user_message
    })
    return messages, user_sources


# Startup
init_db()
reload_rag()

# =========================
# AUTH ROUTES
# =========================
@app.route("/register", methods=["GET", "POST"])
def register():
    if request.method == "GET":
        return render_template("register.html")

    username = request.form.get("username", "").strip()
    email = request.form.get("email", "").strip().lower()
    password = request.form.get("password", "")

    if not username or not email or not password:
        flash("All fields are required.", "error")
        return redirect(url_for("register"))

    try:
        db = get_db()
        cur = db.cursor()
        cur.execute(
            "INSERT INTO users (username, email, password_hash) VALUES (%s, %s, %s)",
            (username, email, generate_password_hash(password)),
        )
        db.commit()
        cur.close()
        db.close()
        flash("Account created successfully. Please login.", "success")
        return redirect(url_for("login"))
    except mysql.connector.IntegrityError:
        flash("Username or email already exists.", "error")
        return redirect(url_for("register"))
    except Exception as e:
        flash(f"Database error: {e}", "error")
        return redirect(url_for("register"))


@app.route("/login", methods=["GET", "POST"])
def login():
    if request.method == "GET":
        return render_template("login.html")

    identifier = request.form.get("identifier", "").strip()
    password = request.form.get("password", "")

    db = get_db()
    cur = db.cursor(dictionary=True)
    cur.execute("SELECT * FROM users WHERE username=%s OR email=%s", (identifier, identifier))
    user = cur.fetchone()
    cur.close()
    db.close()

    if user and check_password_hash(user["password_hash"], password):
        session["user_id"] = user["id"]
        session["username"] = user["username"]
        return redirect(url_for("home"))

    flash("Invalid login details.", "error")
    return redirect(url_for("login"))


@app.route("/logout")
def logout():
    session.clear()
    return redirect(url_for("login"))

# =========================
# APP ROUTES
# =========================
@app.route("/")
@login_required
def home():
    return render_template("index.html", username=session.get("username"))


@app.route("/upload", methods=["POST"])
@login_required
def upload():
    """Upload files and save metadata (DATA ISOLATION: user_id)"""
    user_id = session["user_id"]
    chat_id = request.form.get("chat_id")
    if chat_id:
        chat_id = int(chat_id)
        if not user_owns_chat(chat_id, user_id):
            return jsonify({"error": "Unauthorized chat access"}), 403

    files = request.files.getlist("files") or ([request.files.get("file")] if request.files.get("file") else [])
    if not files:
        return jsonify({"error": "No files uploaded"}), 400

    uploaded, errors = [], []
    for file in files:
        if not file or file.filename == "":
            continue
        if not allowed_file(file.filename):
            errors.append(f"{file.filename}: unsupported file type")
            continue
        
        original_filename = file.filename
        filename = secure_filename(file.filename)
        path = UPLOAD_FOLDER / filename
        file.save(path)
        
        if chat_id:
            save_uploaded_file_db(user_id, chat_id, original_filename, filename, str(path))
        else:
            save_uploaded_file_db(user_id, None, original_filename, filename, str(path))
        
        uploaded.append({"filename": original_filename, "status": "ok"})

    if uploaded:
        reload_rag()

    return jsonify({"message": f"Uploaded {len(uploaded)} file(s)", "files": uploaded, "errors": errors})


@app.route("/chat", methods=["POST"])
@login_required
def chat():
    """Handle chat message (both user and AI responses saved to database)"""
    data = request.get_json(silent=True) or {}
    user_message = data.get("message", "").strip()
    chat_id = data.get("chat_id")

    if not user_message:
        return Response("No message provided", status=400)

    user_id = session["user_id"]

    if not chat_id:
        chat_id = create_chat_db(user_id, user_message[:60])
    else:
        chat_id = int(chat_id)
        if not user_owns_chat(chat_id, user_id):
            return jsonify({"error": "Unauthorized chat access"}), 403

    # SAVE USER MESSAGE TO DATABASE
    save_message_db(chat_id, user_id, "user", user_message)
    
    messages, user_sources = build_ai_messages(user_message, chat_id, user_id)

    def generate():
        full_response = ""
        try:
            if client is None:
                raise RuntimeError("GROQ_API_KEY is not configured")

            response = client.chat.completions.create(
                model=MODEL_NAME,
                messages=messages,
                temperature=0.45,
                max_tokens=2048,
                stream=True,
            )

            yield f"data: {json.dumps({'chat_id': chat_id})}\n\n"

            for chunk in response:
                content = chunk.choices[0].delta.content
                if content:
                    full_response += content
                    yield f"data: {json.dumps({'token': content})}\n\n"

            if user_sources:
                source_text = "\n\n**Sources:**\n" + "\n".join([f"- {src}" for src in user_sources])
                full_response += source_text
                yield f"data: {json.dumps({'token': source_text})}\n\n"

            # SAVE AI RESPONSE TO DATABASE
            save_message_db(chat_id, user_id, "assistant", full_response)
            yield f"data: {json.dumps({'done': True, 'chat_id': chat_id})}\n\n"

        except Exception as e:
            error_msg = str(e)
            yield f"data: {json.dumps({'error': error_msg})}\n\n"

    return Response(
        stream_with_context(generate()),
        mimetype="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )

# =========================
# CHAT API ROUTES (DATA ISOLATION on all)
# =========================
@app.route("/api/chats", methods=["GET"])
@login_required
def api_get_chats():
    """Get user's chats only (DATA ISOLATION: WHERE user_id)"""
    db = get_db()
    cur = db.cursor(dictionary=True)
    cur.execute(
        "SELECT id, title, created_at, updated_at FROM chats WHERE user_id=%s ORDER BY updated_at DESC, id DESC",
        (session["user_id"],),
    )
    rows = cur.fetchall()
    cur.close()
    db.close()
    return jsonify({"chats": rows})


@app.route("/api/chats", methods=["POST"])
@login_required
def api_create_chat():
    """Create chat for logged-in user only"""
    data = request.get_json(silent=True) or {}
    title = data.get("title") or "New Chat"
    chat_id = create_chat_db(session["user_id"], title)
    return jsonify({"id": chat_id, "title": title})


@app.route("/api/chats/<int:chat_id>/messages", methods=["GET"])
@login_required
def api_get_messages(chat_id):
    """Get messages only if user owns chat (DATA ISOLATION check)"""
    if not user_owns_chat(chat_id, session["user_id"]):
        return jsonify({"error": "Unauthorized"}), 403
    
    db = get_db()
    cur = db.cursor(dictionary=True)
    cur.execute(
        "SELECT role, content, created_at FROM messages WHERE chat_id=%s AND user_id=%s ORDER BY created_at ASC, id ASC",
        (chat_id, session["user_id"]),
    )
    rows = cur.fetchall()
    cur.close()
    db.close()
    messages = [{"role": r["role"], "content": r["content"]} for r in rows]
    return jsonify({"messages": messages})


@app.route("/api/chats/<int:chat_id>", methods=["PATCH"])
@login_required
def api_rename_chat(chat_id):
    """Rename chat only if user owns it (DATA ISOLATION check)"""
    if not user_owns_chat(chat_id, session["user_id"]):
        return jsonify({"error": "Unauthorized"}), 403
    data = request.get_json(silent=True) or {}
    title = (data.get("title") or "New Chat").strip()[:255]
    db = get_db()
    cur = db.cursor()
    cur.execute("UPDATE chats SET title=%s WHERE id=%s AND user_id=%s", (title, chat_id, session["user_id"]))
    db.commit()
    cur.close()
    db.close()
    return jsonify({"success": True})


@app.route("/api/chats/<int:chat_id>", methods=["DELETE"])
@login_required
def api_delete_chat(chat_id):
    """Delete chat only if user owns it (DATA ISOLATION check)"""
    if not user_owns_chat(chat_id, session["user_id"]):
        return jsonify({"error": "Unauthorized"}), 403
    db = get_db()
    cur = db.cursor()
    cur.execute("DELETE FROM chats WHERE id=%s AND user_id=%s", (chat_id, session["user_id"]))
    db.commit()
    cur.close()
    db.close()
    return jsonify({"success": True})


@app.route("/health")
def health():
    return jsonify({"status": "ok", "rag_chunks": len(documents), "db": DB_CONFIG["database"]})


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, threaded=True, debug=False)
