"""
database.py
طبقة الوصول لقاعدة بيانات PostgreSQL عبر مكتبة psycopg2.
يُنشئ الجداول تلقائيًا من schema.sql عند أول تشغيل إذا لم تكن موجودة.

قبل التشغيل محليًا:
  1) ثبّت PostgreSQL وشغّله (أو استخدم pgAdmin لإدارته).
  2) أنشئ قاعدة بيانات باسم eye_gaze_db.
  3) عدّل بيانات الاتصال (DB_*) أسفل حسب إعدادك المحلي، أو اتركها كما هي إذا كانت القيم الافتراضية تطابق إعدادك.
  4) ثبّت المكتبة: python -m pip install -r requirements.txt

عند الاستضافة السحابية (مثل Railway):
  تُقرأ بيانات الاتصال تلقائيًا من متغيرات البيئة التي توفرها المنصة، بدون أي تعديل يدوي بالكود.
"""
import os
from pathlib import Path

import hashlib
import secrets
import psycopg2
import psycopg2.extras

# ---------------- بيانات الاتصال بقاعدة البيانات ----------------
# تُقرأ تلقائيًا من متغيرات البيئة إذا كانت موجودة (استضافة سحابية)،
# وإلا تُستخدم القيم المحلية الافتراضية (PostgreSQL على جهازك).
DB_HOST = os.environ.get("PGHOST", "localhost")
DB_PORT = int(os.environ.get("PGPORT", 5432))
DB_NAME = os.environ.get("PGDATABASE", "eye_gaze_db")
DB_USER = os.environ.get("PGUSER", "postgres")
DB_PASSWORD = os.environ.get("PGPASSWORD", "")

SCHEMA_PATH = Path(__file__).parent / "schema.sql"


def get_conn():
    return psycopg2.connect(
        host=DB_HOST, port=DB_PORT, dbname=DB_NAME,
        user=DB_USER, password=DB_PASSWORD,
        cursor_factory=psycopg2.extras.RealDictCursor,
    )


def init_db():
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(SCHEMA_PATH.read_text(encoding="utf-8"))
        conn.commit()
    finally:
        conn.close()


# ---------------- كلمات المرور ----------------
def hash_password(password: str, salt: str | None = None):
    salt = salt or secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), 100_000).hex()
    return digest, salt


# ---------------- المستخدمون ----------------
def create_user(full_name: str, email: str, password: str, role: str = "patient"):
    pw_hash, salt = hash_password(password)
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            try:
                cur.execute(
                    "INSERT INTO users (full_name, email, password_hash, password_salt, role) "
                    "VALUES (%s, %s, %s, %s, %s) RETURNING user_id",
                    (full_name, email.lower().strip(), pw_hash, salt, role),
                )
                user_id = cur.fetchone()["user_id"]
                conn.commit()
                return {"ok": True, "user_id": user_id}
            except psycopg2.errors.UniqueViolation:
                conn.rollback()
                return {"ok": False, "error": "هذا البريد الإلكتروني مسجّل مسبقًا"}
    finally:
        conn.close()


def verify_user(email: str, password: str):
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT * FROM users WHERE email = %s", (email.lower().strip(),))
            row = cur.fetchone()
    finally:
        conn.close()
    if not row:
        return None
    digest, _ = hash_password(password, row["password_salt"])
    if secrets.compare_digest(digest, row["password_hash"]):
        return dict(row)
    return None


# ---------------- الجلسات ----------------
def create_session(user_id: int, dwell_ms: int = 5000):
    token = secrets.token_hex(24)
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO sessions (user_id, token, dwell_ms) VALUES (%s, %s, %s) "
                "RETURNING session_id",
                (user_id, token, dwell_ms),
            )
            session_id = cur.fetchone()["session_id"]
            conn.commit()
            return {"session_id": session_id, "token": token}
    finally:
        conn.close()


def get_session_by_token(token: str):
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT * FROM sessions WHERE token = %s", (token,))
            row = cur.fetchone()
    finally:
        conn.close()
    return dict(row) if row else None


def end_session(token: str):
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE sessions SET end_time = CURRENT_TIMESTAMP "
                "WHERE token = %s AND end_time IS NULL",
                (token,),
            )
        conn.commit()
    finally:
        conn.close()


# ---------------- المعايرة ----------------
def log_calibration(session_id: int, points_count: int):
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO calibrations (session_id, points_count) VALUES (%s, %s)",
                (session_id, points_count),
            )
        conn.commit()
    finally:
        conn.close()


# ---------------- الرسائل وسجل الحروف ----------------
def save_message(session_id: int, user_id: int, full_text: str):
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO messages (session_id, user_id, full_text) VALUES (%s, %s, %s) "
                "RETURNING message_id",
                (session_id, user_id, full_text),
            )
            message_id = cur.fetchone()["message_id"]
            conn.commit()
            return message_id
    finally:
        conn.close()


def log_letter_selection(session_id: int, letter: str, sequence_order: int,
                          dwell_time_ms: int, confirmed_by: str = "blink", message_id=None):
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO letter_selections "
                "(session_id, message_id, letter, sequence_order, dwell_time_ms, confirmed_by) "
                "VALUES (%s, %s, %s, %s, %s, %s)",
                (session_id, message_id, letter, sequence_order, dwell_time_ms, confirmed_by),
            )
        conn.commit()
    finally:
        conn.close()


# ---------------- النصوص المحفوظة (لصفحة "النصوص السابقة") ----------------
def message_history(user_id: int, limit: int = 50):
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT message_id, full_text, created_at "
                "FROM messages WHERE user_id = %s AND full_text <> '' "
                "ORDER BY created_at DESC LIMIT %s",
                (user_id, limit),
            )
            rows = cur.fetchall()
    finally:
        conn.close()
    return [dict(r) for r in rows]


# ---------------- تقارير بسيطة ----------------
def session_history(user_id: int):
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT s.session_id, s.start_time, s.end_time, s.dwell_ms, "
                "       COUNT(DISTINCT c.calibration_id) AS calibrations, "
                "       COUNT(DISTINCT l.selection_id)   AS letters_typed "
                "FROM sessions s "
                "LEFT JOIN calibrations c ON c.session_id = s.session_id "
                "LEFT JOIN letter_selections l ON l.session_id = s.session_id "
                "WHERE s.user_id = %s "
                "GROUP BY s.session_id ORDER BY s.start_time DESC",
                (user_id,),
            )
            rows = cur.fetchall()
    finally:
        conn.close()
    return [dict(r) for r in rows]
