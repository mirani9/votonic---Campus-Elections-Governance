const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const mongoose = require('mongoose');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Cloud NoSQL Connection (Optional: Set MONGO_URI in Render/Environment for Cloud MongoDB Atlas)
const MONGO_URI = process.env.MONGO_URI || "";
let useCloudDB = false;

const StoreSchema = new mongoose.Schema({
  key: { type: String, unique: true },
  data: { type: mongoose.Schema.Types.Mixed }
});
const CloudStore = mongoose.model('CloudStore', StoreSchema);

const DB_FILE = path.join(__dirname, 'poll_store.json');

let db = {
  globalStatus: "OPEN",
  users: [
    { id: "ADMIN001", name: "System Admin", role: "ADMIN", password: "admin" },
    { id: "STUDENT001", name: "Alex Mercer", role: "STUDENT", password: "123", candidateCredentials: null },
    { id: "STUDENT002", name: "Riya Sharma", role: "STUDENT", password: "123", candidateCredentials: { candId: "CAND-101", candPass: "pass101", electionId: "el-2" } }
  ],
  elections: [
    { id: "el-1", title: "Sports Secretary 2027", description: "Lead campus athletics & tournaments", deadline: "2026-11-20", status: "CLOSED" },
    { id: "el-2", title: "Cultural Club Head", description: "Manage campus fests & cultural events", deadline: "2026-12-05", status: "OPEN" },
    { id: "el-3", title: "Technical Council Lead", description: "Hackathons, coding clubs & tech fests", deadline: "2026-11-28", status: "OPEN" }
  ],
  candidacyRequests: [
    { id: "req-1", studentId: "STUDENT001", studentName: "Alex Mercer", electionId: "el-2", electionTitle: "Cultural Club Head", reason: "Organized 3 college fests", status: "PENDING" }
  ],
  candidates: [
    {
      candId: "CAND-101",
      studentId: "STUDENT002",
      electionId: "el-2",
      name: "Riya Sharma",
      slogan: "Creativity Without Boundaries!",
      manifesto: "24/7 rehearsal rooms, transparent fest budgets, and inter-college cultural exchange.",
      department: "Computer Engineering - TY",
      avatar: "👩‍🎓",
      votes: 24
    }
  ],
  votes: []
};

async function initDB() {
  if (MONGO_URI) {
    try {
      await mongoose.connect(MONGO_URI);
      useCloudDB = true;
      console.log(">>> Connected to Cloud MongoDB Atlas!");
      const doc = await CloudStore.findOne({ key: 'votonic_master' });
      if (doc && doc.data) {
        db = Object.assign(db, doc.data);
      } else {
        await CloudStore.create({ key: 'votonic_master', data: db });
      }
      return;
    } catch (err) {
      console.log(">>> Cloud DB fallback to persistent JSON:", err.message);
    }
  }
  if (fs.existsSync(DB_FILE)) {
    try {
      const loaded = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      if (loaded) db = Object.assign(db, loaded);
    } catch (e) {}
  }
}

async function saveDB() {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
  if (useCloudDB) {
    try {
      await CloudStore.findOneAndUpdate({ key: 'votonic_master' }, { data: db }, { upsert: true });
    } catch (e) {}
  }
}

let clients = [];
function broadcastEvent(eventType, payload) {
  const data = JSON.stringify({ event: eventType, ...payload, timestamp: new Date().toISOString() });
  clients.forEach(c => c.res.write(`data: ${data}\n\n`));
}

// 1. Sync State Endpoint
app.get('/api/state', (req, res) => {
  res.json({
    globalStatus: db.globalStatus,
    elections: db.elections,
    candidates: db.candidates,
    candidacyRequests: db.candidacyRequests,
    dbMode: useCloudDB ? "MongoDB Atlas Cloud" : "Persistent Local Store"
  });
});

// 2. Authentication (Student, Candidate, Admin)
app.post('/api/login', (req, res) => {
  const { role, id, password } = req.body;
  if (role === 'ADMIN') {
    const admin = db.users.find(u => u.role === 'ADMIN' && u.id === id && u.password === password);
    if (!admin) return res.status(401).json({ error: "Invalid Admin ID or Password" });
    return res.json({ user: admin });
  }
  if (role === 'STUDENT') {
    const student = db.users.find(u => u.role === 'STUDENT' && u.id === id && u.password === password);
    if (!student) return res.status(401).json({ error: "Invalid Student Roll ID or Password" });
    return res.json({ user: student });
  }
  if (role === 'CANDIDATE') {
    const student = db.users.find(u => u.candidateCredentials && u.candidateCredentials.candId === id && u.candidateCredentials.candPass === password);
    if (!student) return res.status(401).json({ error: "Invalid Candidate ID or Password" });
    const profile = db.candidates.find(c => c.candId === id);
    return res.json({ candidate: profile, credentials: student.candidateCredentials });
  }
  res.status(400).json({ error: "Invalid role" });
});

// 3. Get Updated Student Profile (for checking approval & credentials)
app.get('/api/student/:id', (req, res) => {
  const student = db.users.find(u => u.id === req.params.id);
  if (!student) return res.status(404).json({ error: "Not found" });
  const requests = db.candidacyRequests.filter(r => r.studentId === req.params.id);
  res.json({ user: student, requests });
});

// 4. Student Requests Candidacy
app.post('/api/candidacy/request', async (req, res) => {
  const { studentId, electionId, reason } = req.body;
  const student = db.users.find(u => u.id === studentId);
  const election = db.elections.find(e => e.id === electionId);
  if (!student || !election) return res.status(404).json({ error: "Invalid student or election" });

  const dup = db.candidacyRequests.find(r => r.studentId === studentId && r.electionId === electionId && r.status === 'PENDING');
  if (dup) return res.status(400).json({ error: "Request already pending for this election." });

  const newReq = {
    id: 'req-' + Date.now(),
    studentId,
    studentName: student.name,
    electionId,
    electionTitle: election.title,
    reason: reason || "Willing to serve campus governance",
    status: "PENDING"
  };
  db.candidacyRequests.push(newReq);
  await saveDB();
  broadcastEvent('state_updated', {});
  res.json({ status: "SUCCESS", request: newReq });
});

// 5. Admin Approves / Rejects Candidacy -> Generates Candidate ID & Password
app.post('/api/candidacy/review', async (req, res) => {
  const { requestId, action } = req.body; // ACCEPTED or REJECTED
  const request = db.candidacyRequests.find(r => r.id === requestId);
  if (!request) return res.status(404).json({ error: "Request not found" });

  request.status = action;

  if (action === 'ACCEPTED') {
    const student = db.users.find(u => u.id === request.studentId);
    const candId = "CAND-" + Math.floor(100 + Math.random() * 900);
    const candPass = "pass" + Math.floor(1000 + Math.random() * 9000);

    if (student) {
      student.candidateCredentials = {
        candId,
        candPass,
        electionId: request.electionId,
        electionTitle: request.electionTitle
      };
    }

    db.candidates.push({
      candId,
      studentId: request.studentId,
      electionId: request.electionId,
      name: request.studentName,
      slogan: "Ready to Lead & Serve!",
      manifesto: request.reason,
      department: "Campus Student Representative",
      avatar: "🧑‍💼",
      votes: 0
    });
  }

  await saveDB();
  broadcastEvent('state_updated', {});
  res.json({ status: "SUCCESS" });
});

// 6. Candidate Updates Public Profile (Shown on Homepage 3D Cards)
app.post('/api/candidate/profile', async (req, res) => {
  const { candId, slogan, manifesto, department, avatar } = req.body;
  const cand = db.candidates.find(c => c.candId === candId);
  if (!cand) return res.status(404).json({ error: "Candidate profile not found" });

  cand.slogan = slogan || cand.slogan;
  cand.manifesto = manifesto || cand.manifesto;
  cand.department = department || cand.department;
  cand.avatar = avatar || cand.avatar;

  await saveDB();
  broadcastEvent('state_updated', {});
  res.json({ status: "SUCCESS", candidate: cand });
});

// 7. Admin Election Controls (Global & Per-Election)
app.post('/api/poll/toggle', async (req, res) => {
  const { electionId, status } = req.body;
  if (electionId === 'ALL') {
    db.globalStatus = status;
    db.elections.forEach(e => e.status = status);
  } else {
    const el = db.elections.find(e => e.id === electionId);
    if (el) el.status = status;
  }
  await saveDB();
  broadcastEvent('state_updated', {});
  res.json({ status: "SUCCESS" });
});

app.post('/api/elections', async (req, res) => {
  const { title, description, deadline } = req.body;
  if (!title) return res.status(400).json({ error: "Title required" });
  db.elections.push({
    id: 'el-' + Date.now(),
    title,
    description: description || "Campus Governance Election",
    deadline: deadline || "2026-12-31",
    status: "OPEN"
  });
  await saveDB();
  broadcastEvent('state_updated', {});
  res.json({ status: "SUCCESS" });
});

app.post('/api/users', async (req, res) => {
  const { id, name, password } = req.body;
  if (!id || !name) return res.status(400).json({ error: "ID and Name required" });
  db.users.push({ id, name, role: "STUDENT", password: password || "123", candidateCredentials: null });
  await saveDB();
  broadcastEvent('state_updated', {});
  res.json({ status: "SUCCESS" });
});

// 8. Voting Endpoint
app.post('/api/vote', async (req, res) => {
  const { voterId, candId, electionId } = req.body;
  if (db.globalStatus === 'CLOSED') {
    return res.status(403).json({ error: "All elections are CLOSED by Admin." });
  }
  const el = db.elections.find(e => e.id === electionId);
  if (!el || el.status !== 'OPEN') {
    return res.status(403).json({ error: "This election is currently CLOSED." });
  }
  const alreadyVoted = db.votes.find(v => v.voterId === voterId && v.electionId === electionId);
  if (alreadyVoted) {
    return res.status(429).json({ error: "You have already cast your vote in this election." });
  }
  const cand = db.candidates.find(c => c.candId === candId && c.electionId === electionId);
  if (!cand) return res.status(404).json({ error: "Candidate not found." });

  db.votes.push({ voterId, candId, electionId, timestamp: new Date().toISOString() });
  cand.votes++;
  await saveDB();
  broadcastEvent('state_updated', {});
  res.json({ status: "SUCCESS" });
});

// 9. SSE Real-Time Stream
app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  const clientId = Date.now();
  clients.push({ id: clientId, res });
  req.on('close', () => { clients = clients.filter(c => c.id !== clientId); });
});

initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`\n==================================================`);
    console.log(`[VOTONIC Cloud Engine] RUNNING on http://localhost:${PORT}`);
    console.log(`==================================================\n`);
  });
});