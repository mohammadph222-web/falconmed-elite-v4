# دليل التشغيل والنشر — FalconMed Elite v4

هذا المشروع **مستقل تماماً** عن v3. لا تنسخ ملفاته فوق المستودعات القديمة. v3 يبقى يعمل كما هو حتى تنقل الروابط إلى v4.

---

## الخطوة 0 — قبل أي شيء: تغيير كلمة سر Neon ⚠️

كلمة سر قاعدة البيانات الحالية مكشوفة في مستودع `falconmed-backend` العام، داخل الملفين `.env.txt` و `.env1`.

1. افتح **Neon Console** ← مشروعك ← **Roles** ← `neondb_owner` ← **Reset password**.
2. انسخ رابط الاتصال الجديد (Connection string – **Pooled**).
3. في **Render** ← خدمة `falconmed-backend` القديمة ← **Environment** ← حدّث `DATABASE_URL` بالرابط الجديد، حتى يستمر v3 في العمل.
4. احذف الملفين `.env.txt` و `.env1` من مستودع v3 وارفع التعديل.
   ملاحظة: تبقى الكلمة القديمة في تاريخ Git، لذلك تغيير الكلمة هو الحماية الحقيقية، وليس الحذف.

---

## الخطوة 1 — التشغيل على جهازك

المتطلبات: Node.js 20 أو أحدث.

### Backend

```bash
cd backend
npm install
copy .env.example .env        # في Windows (أو cp في Mac/Linux)
```

افتح ملف `.env` واملأ القيم التالية:

| المتغير | القيمة |
|---|---|
| `DATABASE_URL` | رابط Neon **الجديد** (Pooled) |
| `JWT_SECRET` | نص عشوائي طويل. ولّده بالأمر بعد الجدول |
| `QUEUE_API_KEY` | نص عشوائي آخر (مفتاح آلة الطابور) |
| `DEMO_PASSWORD` | كلمة سر الحسابات التجريبية (الافتراضي `Demo@2026`) |

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

ثم:

```bash
npm run setup      # ينشئ الجداول + يولّد 60 يوماً من البيانات التجريبية (~146 ألف تذكرة)
npm run dev        # يشغّل الـ API على http://localhost:5000
```

**هل يؤثر هذا على بيانات v3؟** لا. v4 يعمل داخل schema منفصل اسمه `falconmed_v4`، ولا يلمس جداول v3 (`patient_logs`، `transactions`…).

### Frontend

```bash
cd frontend
npm install
copy .env.example .env        # VITE_API_URL=http://localhost:5000
npm run dev                   # http://localhost:5173
```

### الحسابات التجريبية

كلمة السر لكل الحسابات هي قيمة `DEMO_PASSWORD`.

| الدور | البريد |
|---|---|
| صيدلي (كاونتر 1) | `pharmacist@demo.falconmed.app` |
| مدير فرع | `manager@demo.falconmed.app` |
| مدير الشبكة | `admin@demo.falconmed.app` |
| صيادلة آخرون | `ph.ad01.2@demo.falconmed.app` … `ph.dx01.4@demo.falconmed.app` |

**تجربة كاملة للنظام:**
1. افتح نافذتين.
2. في الأولى: حساب الأدمن ← **Queue simulator** ← **Start auto arrivals**.
3. في الثانية: حساب الصيدلي ← **Call next** ← **Served**.
4. أو استخدم الاختصارات من لوحة المفاتيح: `N` نداء التالي، `S` تمت الخدمة، `X` لم يحضر.

---

## الخطوة 2 — النشر (مجاني بالكامل)

### أ) GitHub

أنشئ مستودعاً **جديداً** باسم `falconmed-elite-v4` وارفع المجلد كاملاً:

```bash
git init
git add .
git commit -m "FalconMed Elite v4"
git branch -M main
git remote add origin https://github.com/mohammadph222-web/falconmed-elite-v4.git
git push -u origin main
```

قبل الـ push، شغّل `git status` وتأكد من عدم ظهور أي ملف `.env`. ملف `.gitignore` يمنعها تلقائياً.

### ب) Render (الـ Backend)

1. New ← **Web Service** ← اختر `falconmed-elite-v4`.
2. اضبط الإعدادات:

| الإعداد | القيمة |
|---|---|
| Root Directory | `backend` |
| Build Command | `npm install` |
| Start Command | `npm start` |
| Health Check Path | `/api/health` |

3. في **Environment** أضف المتغيرات التالية:
   - `DATABASE_URL`، `JWT_SECRET`، `QUEUE_API_KEY`، `DEMO_PASSWORD`
   - `NODE_ENV=production`
   - `CORS_ORIGINS=https://dashboard.falconmed.app,https://falconmed-elite-v4.vercel.app`
4. عند التشغيل، السيرفر ينشئ الجداول تلقائياً. أما البيانات التجريبية فتُضاف مرة واحدة من جهازك عبر `npm run setup`، وهو يستخدم نفس `DATABASE_URL`.

### ج) Vercel (الـ Frontend)

1. Add New ← Project ← `falconmed-elite-v4`.
2. اضبط **Root Directory** على `frontend`. Vercel يكتشف Vite تلقائياً.
3. أضف متغير البيئة `VITE_API_URL` بقيمة رابط Render الجديد، مثلاً `https://falconmed-elite-v4-api.onrender.com`.
4. اضغط Deploy.

### د) الدومين (Cloudflare)

- عدّل سجل CNAME للنطاق `dashboard` ليشير إلى مشروع Vercel الجديد، بإعداد **DNS only**.
- في Vercel ← Settings ← Domains ← أضف `dashboard.falconmed.app`.
- تأكد أن `CORS_ORIGINS` في Render يحتوي النطاق نفسه.

---

## ربط آلة طابور حقيقية

أي نظام طابور، مثل Quematic، يستطيع إرسال وصول المريض بطلب واحد:

```http
POST /api/queue/tickets
X-Queue-Key: <QUEUE_API_KEY>
Content-Type: application/json

{ "branchId": "br_ad01", "serviceType": "prescription", "source": "kiosk", "identified": true, "patientRef": "MRN-123456" }
```

- لا تُرسل أسماء المرضى أبداً. الحقل `patientRef` يقبل رمزاً فقط، ويرفض أي نص فيه مسافات.
- رقم التذكرة (`A-001`…) يُولَّد تلقائياً لكل فرع ويوم وخط خدمة.

---

## أوامر مفيدة

| الأمر | الوظيفة |
|---|---|
| `npm run migrate` | تطبيق أي تحديث على قاعدة البيانات (آمن للتكرار) |
| `npm run seed -- --reset` | مسح بيانات v4 التجريبية وإعادة توليدها |
| `npm run seed -- --reset --days=90` | توليد 90 يوماً بدل 60 |
| `npm test` | 33 اختباراً آلياً. ⚠️ يحتاج قاعدة بيانات **تجريبية منفصلة**، لأنه يعيد توليد البيانات |
| `npm run build` (frontend) | بناء نسخة الإنتاج |

## حل المشاكل الشائعة

| المشكلة | الحل |
|---|---|
| أول تحميل بطيء (حتى دقيقة) | Render المجاني ينام بعد 15 دقيقة. الواجهة تعرض رسالة "Waking the server" وتنتظر 65 ثانية |
| `Invalid environment configuration` | متغير ناقص في `.env`. الرسالة تذكر اسمه |
| CORS error في المتصفح | أضف رابط الواجهة بالضبط إلى `CORS_ORIGINS` في Render |
| الصيدلي لا يستطيع نداء مريض جديد | يجب إنهاء التذكرة الحالية أولاً (Served أو No-show). التذاكر المفتوحة من أيام سابقة تُغلق تلقائياً |
