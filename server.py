"""
server.py
سيرفر واحد يقوم بأمرين:
  1) تقديم ملفات الواجهة (HTML/CSS/JS) المسموح بها فقط (قائمة بيضاء، فلا تُكشف ملفات الكود).
  2) توفير نقاط API (تسجيل، دخول، نسيت كلمة المرور، جلسات/معايرة/حروف/نصوص/حساب) تخزّن في PostgreSQL.
يعتمد على مكتبات بايثون القياسية + psycopg2 (للاتصال بـ PostgreSQL).
"""
import http.server
import json
import os
import socketserver
import webbrowser

import account
import database as db
import password_reset

# على جهازك محليًا يشتغل على المنفذ 8000.
# عند الاستضافة السحابية (مثل Railway)، تحدّد المنصة نفسها رقم المنفذ عبر متغير البيئة PORT.
PORT = int(os.environ.get("PORT", 8000))
IS_CLOUD = "PORT" in os.environ  # Railway وأغلب منصات الاستضافة تضبط PORT تلقائيًا
# محليًا: 127.0.0.1 (جهازك فقط). في الاستضافة: 0.0.0.0 (لازم، وإلا ما يوصل للخادم أحد من الخارج).
HOST = "0.0.0.0" if IS_CLOUD else "127.0.0.1"

# الملفات الوحيدة التي يحق للمتصفح تحميلها. أي ملف ثاني (مثل database.py أو schema.sql) يرجّع 404.
PUBLIC_FILES = {"/index.html", "/login.html", "/forgot.html", "/reset.html", "/style.css", "/script.js"}


class Handler(http.server.SimpleHTTPRequestHandler):
    # لا نخلي المتصفح (خصوصًا Chrome بالجوال) يحتفظ بنسخة قديمة من script.js/index.html بعد كل تحديث
    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    # ---------- تقديم الملفات (GET) كما هو معتاد ----------
    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path in ("", "/"):
            path = "/login.html"
        if path not in PUBLIC_FILES:
            self.send_error(404, "File not found")
            return
        self.path = path
        super().do_GET()

    # ---------- نقاط الـ API (POST) ----------
    def do_POST(self):
        routes = {
            "/api/register": self.handle_register,
            "/api/login": self.handle_login,
            "/api/logout": self.handle_logout,
            "/api/calibration": self.handle_calibration,
            "/api/letter": self.handle_letter,
            "/api/message": self.handle_message,
            "/api/history": self.handle_history,
            "/api/messages": self.handle_messages,
            "/api/texts": self.handle_texts,
            "/api/text_delete": self.handle_text_delete,
            "/api/profile": self.handle_profile,
            "/api/profile_update": self.handle_profile_update,
            "/api/password_change": self.handle_password_change,
            "/api/forgot": self.handle_forgot,
            "/api/reset_check": self.handle_reset_check,
            "/api/reset": self.handle_reset,
        }
        handler = routes.get(self.path)
        if not handler:
            self.send_json({"ok": False, "error": "مسار غير معروف"}, status=404)
            return
        try:
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length) or b"{}")
        except Exception:
            self.send_json({"ok": False, "error": "بيانات غير صالحة"}, status=400)
            return
        try:
            handler(body)
        except Exception as e:
            print("خطأ في", self.path, "->", repr(e))
            self.send_json({"ok": False, "error": "حدث خطأ في الخادم، حاول مرة أخرى"}, 500)

    # ---------- أدوات مساعدة ----------
    def send_json(self, data, status=200):
        payload = json.dumps(data, ensure_ascii=False, default=str).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def require_session(self, body):
        """يتحقق من رمز الجلسة (token) المرسل من الواجهة الأمامية."""
        token = body.get("token")
        session = db.get_session_by_token(token) if token else None
        if not session or session["end_time"] is not None:
            return None
        return session

    # ---------- المعالِجات ----------
    def handle_register(self, body):
        full_name = (body.get("full_name") or "").strip()
        email = (body.get("email") or "").strip()
        password = body.get("password") or ""
        if not full_name or not email or len(password) < 4:
            self.send_json({"ok": False, "error": "أكمل جميع الحقول (كلمة المرور 4 أحرف على الأقل)"}, 400)
            return
        result = db.create_user(full_name, email, password)
        self.send_json(result, 200 if result["ok"] else 400)

    def handle_login(self, body):
        email = (body.get("email") or "").strip()
        password = body.get("password") or ""
        user = db.verify_user(email, password)
        if not user:
            self.send_json({"ok": False, "error": "البريد أو كلمة المرور غير صحيحة"}, 401)
            return
        session = db.create_session(user["user_id"], dwell_ms=body.get("dwell_ms", 5000))
        self.send_json({
            "ok": True,
            "token": session["token"],
            "session_id": session["session_id"],
            "user_id": user["user_id"],
            "full_name": user["full_name"],
        })

    def handle_logout(self, body):
        token = body.get("token")
        if token:
            db.end_session(token)
        self.send_json({"ok": True})

    def handle_calibration(self, body):
        session = self.require_session(body)
        if not session:
            self.send_json({"ok": False, "error": "جلسة غير صالحة"}, 401)
            return
        db.log_calibration(session["session_id"], int(body.get("points_count", 0)))
        self.send_json({"ok": True})

    def handle_letter(self, body):
        session = self.require_session(body)
        if not session:
            self.send_json({"ok": False, "error": "جلسة غير صالحة"}, 401)
            return
        db.log_letter_selection(
            session_id=session["session_id"],
            letter=body.get("letter", ""),
            sequence_order=int(body.get("sequence_order", 0)),
            dwell_time_ms=int(body.get("dwell_time_ms", 0)),
            confirmed_by=body.get("confirmed_by", "blink"),
        )
        self.send_json({"ok": True})

    def handle_message(self, body):
        session = self.require_session(body)
        if not session:
            self.send_json({"ok": False, "error": "جلسة غير صالحة"}, 401)
            return
        message_id = db.save_message(session["session_id"], session["user_id"], body.get("full_text", ""))
        self.send_json({"ok": True, "message_id": message_id})

    def handle_history(self, body):
        session = self.require_session(body)
        if not session:
            self.send_json({"ok": False, "error": "جلسة غير صالحة"}, 401)
            return
        self.send_json({"ok": True, "sessions": db.session_history(session["user_id"])})

    def handle_messages(self, body):
        session = self.require_session(body)
        if not session:
            self.send_json({"ok": False, "error": "جلسة غير صالحة"}, 401)
            return
        self.send_json({"ok": True, "messages": db.message_history(session["user_id"])})

    def need_session(self, body):
        session = self.require_session(body)
        if not session:
            self.send_json({"ok": False, "error": "جلسة غير صالحة"}, 401)
        return session

    # ---------- النصوص السابقة + الحساب ----------
    def handle_texts(self, body):
        session = self.need_session(body)
        if not session:
            return
        self.send_json({"ok": True, "texts": account.list_texts(session["user_id"])})

    def handle_text_delete(self, body):
        session = self.need_session(body)
        if not session:
            return
        deleted = account.delete_text(session["user_id"], int(body.get("message_id", 0)))
        if deleted:
            self.send_json({"ok": True})
        else:
            self.send_json({"ok": False, "error": "النص غير موجود"}, 404)

    def handle_profile(self, body):
        session = self.need_session(body)
        if not session:
            return
        data = account.get_profile(session["user_id"])
        if not data:
            self.send_json({"ok": False, "error": "الحساب غير موجود"}, 404)
            return
        self.send_json({"ok": True, **data})

    def handle_profile_update(self, body):
        session = self.need_session(body)
        if not session:
            return
        result = account.update_profile(session["user_id"], body.get("full_name"),
                                        body.get("email"), body.get("current_password"))
        self.send_json(result, 200 if result["ok"] else 400)

    def handle_password_change(self, body):
        session = self.need_session(body)
        if not session:
            return
        result = account.change_password(session["user_id"], body.get("current_password"),
                                         body.get("new_password"), keep_token=body.get("token"))
        self.send_json(result, 200 if result["ok"] else 400)

    # ---------- نسيت كلمة المرور ----------
    def handle_forgot(self, body):
        email = (body.get("email") or "").strip()
        user = password_reset.get_user_by_email(email) if email else None
        if user:
            token = password_reset.create_reset_token(user["user_id"])
            host = self.headers.get("Host", f"localhost:{PORT}")
            scheme = self.headers.get("X-Forwarded-Proto", "http")
            # ما فيه إرسال بريد مضبوط بعد: الرابط يظهر في نافذة الخادم (Terminal)
            print(f"رابط تعيين كلمة المرور لـ {user['email']}: {scheme}://{host}/reset.html?token={token}")
        self.send_json({"ok": True, "message": "إذا كان البريد مسجّلاً، تم إنشاء رابط التعيين (إرسال البريد غير مفعّل بعد، فالرابط يظهر في نافذة الخادم)."})

    def handle_reset_check(self, body):
        token = body.get("token") or ""
        ok = bool(token and password_reset.validate_reset_token(token))
        self.send_json({"ok": ok}, 200 if ok else 400)

    def handle_reset(self, body):
        token = body.get("token") or ""
        password = body.get("password") or ""
        if len(password) < 4:
            self.send_json({"ok": False, "error": "كلمة المرور 4 أحرف على الأقل"}, 400)
            return
        if not token or not password_reset.reset_password(token, password):
            self.send_json({"ok": False, "error": "الرابط غير صالح أو منتهي الصلاحية"}, 400)
            return
        self.send_json({"ok": True})


def open_in_chrome(url):
    """يفتح الرابط في Google Chrome إذا وُجد على الجهاز، وإلا يفتحه في المتصفح الافتراضي."""
    candidates = [
        os.path.expandvars(r"%ProgramFiles%\Google\Chrome\Application\chrome.exe"),
        os.path.expandvars(r"%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"),
        os.path.expandvars(r"%LocalAppData%\Google\Chrome\Application\chrome.exe"),
    ]
    for path in candidates:
        if os.path.exists(path):
            webbrowser.register("chrome", None, webbrowser.BackgroundBrowser(path))
            webbrowser.get("chrome").open(url)
            return
    webbrowser.open(url)


class Server(socketserver.ThreadingMixIn, socketserver.TCPServer):
    """يعالج كل طلب في خيط مستقل حتى لا يعطّل طلبٌ بطيء بقية المستخدمين."""
    daemon_threads = True
    allow_reuse_address = True


if __name__ == "__main__":
    db.init_db()
    with Server((HOST, PORT), Handler) as httpd:
        if IS_CLOUD:
            print(f"الخادم يعمل على المنفذ: {PORT} (استضافة سحابية)")
        else:
            url = f"http://localhost:{PORT}/login.html"
            print(f"الخادم يعمل على: {url}")
            print("اضغط Ctrl+C لإيقاف الخادم")
            open_in_chrome(url)
        httpd.serve_forever()
