"""
account.py
دوال قاعدة البيانات الخاصة بصفحات: النصوص السابقة + الإعدادات (حساب المستخدم).
وحدة مستقلة تستورد الاتصال ودالة التشفير من database.py، فما تحتاج تعدّل database.py.
"""
import secrets

import psycopg2

from database import get_conn, hash_password


def _fmt(dt):
    return dt.strftime("%Y-%m-%d %H:%M") if dt else ""


def _password_ok(row, password: str) -> bool:
    digest, _ = hash_password(password or "", row["password_salt"])
    return secrets.compare_digest(digest, row["password_hash"])


# ---------------- النصوص السابقة ----------------
# كل جملة محفوظة تظهر مرة وحدة: نخفي النسخ الجزئية القديمة (اللي هي بداية لنسخة أطول بنفس الجلسة)
_FINAL_TEXTS = """
    FROM messages m
    WHERE m.user_id = %s AND btrim(m.full_text) <> ''
      AND NOT EXISTS (
          SELECT 1 FROM messages m2
          WHERE m2.session_id = m.session_id AND m2.message_id > m.message_id
            AND starts_with(m2.full_text, m.full_text))
"""


def list_texts(user_id: int, limit: int = 100):
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT m.message_id, m.full_text, m.created_at " + _FINAL_TEXTS +
                        " ORDER BY m.created_at DESC, m.message_id DESC LIMIT %s", (user_id, limit))
            return [{"message_id": r["message_id"], "text": r["full_text"], "created_at": _fmt(r["created_at"])}
                    for r in cur.fetchall()]
    finally:
        conn.close()


def delete_text(user_id: int, message_id: int) -> bool:
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM letter_selections WHERE message_id = %s AND message_id IN "
                        "(SELECT message_id FROM messages WHERE user_id = %s)", (message_id, user_id))
            cur.execute("DELETE FROM messages WHERE message_id = %s AND user_id = %s", (message_id, user_id))
            deleted = cur.rowcount > 0
        conn.commit()
        return deleted
    finally:
        conn.close()


# ---------------- الحساب ----------------
def get_profile(user_id: int):
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT full_name, email, role, created_at FROM users WHERE user_id = %s", (user_id,))
            u = cur.fetchone()
            if not u:
                return None
            cur.execute("SELECT COUNT(*) AS n FROM sessions WHERE user_id = %s", (user_id,))
            sessions = cur.fetchone()["n"]
            cur.execute("SELECT COUNT(*) AS n " + _FINAL_TEXTS, (user_id,))
            texts = cur.fetchone()["n"]
            cur.execute("SELECT COUNT(*) AS n FROM letter_selections l "
                        "JOIN sessions s ON s.session_id = l.session_id "
                        "WHERE s.user_id = %s AND left(l.letter, 1) <> '['", (user_id,))
            letters = cur.fetchone()["n"]
        return {
            "profile": {"full_name": u["full_name"], "email": u["email"],
                        "role": u["role"], "created_at": _fmt(u["created_at"])},
            "stats": {"sessions": sessions, "texts": texts, "letters": letters},
        }
    finally:
        conn.close()


def update_profile(user_id: int, full_name: str, email: str, current_password: str):
    full_name, email = (full_name or "").strip(), (email or "").strip().lower()
    if not full_name or "@" not in email:
        return {"ok": False, "error": "اكتب الاسم وبريدًا إلكترونيًا صحيحًا"}
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT * FROM users WHERE user_id = %s", (user_id,))
            row = cur.fetchone()
            if not row:
                return {"ok": False, "error": "الحساب غير موجود"}
            # تغيير البريد حساس: نطلب كلمة المرور الحالية
            if email != row["email"] and not _password_ok(row, current_password):
                return {"ok": False, "error": "كلمة المرور الحالية غير صحيحة (مطلوبة لتغيير البريد)"}
            try:
                cur.execute("UPDATE users SET full_name = %s, email = %s WHERE user_id = %s",
                            (full_name, email, user_id))
            except psycopg2.IntegrityError:
                conn.rollback()
                return {"ok": False, "error": "هذا البريد مستخدم في حساب آخر"}
        conn.commit()
        return {"ok": True, "full_name": full_name, "email": email}
    finally:
        conn.close()


def change_password(user_id: int, current_password: str, new_password: str, keep_token: str = ""):
    if len(new_password or "") < 4:
        return {"ok": False, "error": "كلمة المرور الجديدة 4 أحرف على الأقل"}
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT * FROM users WHERE user_id = %s", (user_id,))
            row = cur.fetchone()
            if not row or not _password_ok(row, current_password):
                return {"ok": False, "error": "كلمة المرور الحالية غير صحيحة"}
            pw_hash, salt = hash_password(new_password)
            cur.execute("UPDATE users SET password_hash = %s, password_salt = %s WHERE user_id = %s",
                        (pw_hash, salt, user_id))
            # نُنهي بقية الجلسات المفتوحة (أجهزة ثانية) ونُبقي جلستك الحالية
            cur.execute("UPDATE sessions SET end_time = NOW() "
                        "WHERE user_id = %s AND end_time IS NULL AND token <> %s", (user_id, keep_token or ""))
        conn.commit()
        return {"ok": True}
    finally:
        conn.close()
