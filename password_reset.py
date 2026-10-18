"""
password_reset.py
دوال قاعدة البيانات الخاصة بميزة "نسيت كلمة المرور".
وحدة مستقلة تستورد الاتصال ودالة التشفير من database.py، فما تحتاج تعدّل database.py.
"""
import hashlib
import secrets

from database import get_conn, hash_password

RESET_TOKEN_MINUTES = 30


def _hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def get_user_by_email(email: str):
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT user_id, full_name, email FROM users WHERE email = %s",
                        (email.lower().strip(),))
            return cur.fetchone()
    finally:
        conn.close()


def create_reset_token(user_id: int, minutes: int = RESET_TOKEN_MINUTES) -> str:
    """ينشئ رمزًا جديدًا ويبطل أي رموز قديمة غير مستخدمة لنفس المستخدم. يرجّع الرمز الأصلي."""
    token = secrets.token_urlsafe(32)
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("UPDATE password_resets SET used_at = NOW() "
                        "WHERE user_id = %s AND used_at IS NULL", (user_id,))
            cur.execute(
                "INSERT INTO password_resets (user_id, token_hash, expires_at) "
                "VALUES (%s, %s, NOW() + %s * INTERVAL '1 minute')",
                (user_id, _hash_token(token), minutes),
            )
        conn.commit()
        return token
    finally:
        conn.close()


def validate_reset_token(token: str):
    """يرجّع صفًا إذا الرمز صالح (موجود، غير مستخدم، غير منتهي)، وإلا None."""
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT reset_id, user_id FROM password_resets "
                "WHERE token_hash = %s AND used_at IS NULL AND expires_at > NOW()",
                (_hash_token(token),),
            )
            return cur.fetchone()
    finally:
        conn.close()


def reset_password(token: str, new_password: str) -> bool:
    """يغيّر كلمة المرور إذا الرمز صالح، ويبطل الرمز، ويُنهي جلسات المستخدم المفتوحة."""
    pw_hash, salt = hash_password(new_password)
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT reset_id, user_id FROM password_resets "
                "WHERE token_hash = %s AND used_at IS NULL AND expires_at > NOW() FOR UPDATE",
                (_hash_token(token),),
            )
            row = cur.fetchone()
            if not row:
                conn.rollback()
                return False
            uid = row["user_id"]
            cur.execute("UPDATE users SET password_hash = %s, password_salt = %s WHERE user_id = %s",
                        (pw_hash, salt, uid))
            cur.execute("UPDATE password_resets SET used_at = NOW() "
                        "WHERE user_id = %s AND used_at IS NULL", (uid,))
            cur.execute("UPDATE sessions SET end_time = NOW() "
                        "WHERE user_id = %s AND end_time IS NULL", (uid,))
        conn.commit()
        return True
    finally:
        conn.close()
