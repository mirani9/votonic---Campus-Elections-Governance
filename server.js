const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const DB_FILE = path.join(__dirname, 'votonic_store.json');

// System Initial State
let db = {
  users: [
    { id: "STU001", password: "password123", name: "Alex Mercer", role: "STUDENT" },
    { id: "STU002", password: "password123", name: "Bob Smith", role: "STUDENT" },
    { id: "CAND001", password: "password123", name: "Alice Johnson", role: "CANDIDATE" },
    { id: "CAND002", password: "password123", name: "Carol Williams", role: "CANDIDATE" },
    { id: "ADMIN001", password: "adminpassword", name: "System Admin", role: "ADMIN" }
  ],
  elections: [
    { id: "elec-1", title: "Sports Secretary 2027", description: "Lead campus athletics and annual sports fest.", deadline: "2026-11-20", status: "OPEN" },
    { id: "elec-2", title: "Cultural Club Head", description: "Manage cultural events and annual fest.", deadline: "2026-12-05", status: "OPEN" }
  ],
  nominations: [
    { id: "nom-1", electionId: "elec-1", candidateId: "CAND001", candidateName: "Alice Johnson", manifesto: "Better equipment and transparent sports budget.", status: "ACCEPTED" },
    { id: "nom-2", electionId: "elec-1", candidateId: "CAND002", candidateName: "Carol Williams", manifesto: "More inter-college tournaments and coaching.", status: "PENDING" }
  ],
  votes: [] // Format: { voterId, electionId, candidateId, timestamp }
};

if (fs.existsSync(DB_FILE)) {
  try {
    db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch (e) {
    console.log("Initializing default database state...");
  }
}

function saveDB() {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

// -----------------------------------------------------------------------------
// AUTHENTICATION API
// -----------------------------------------------------------------------------
app.post('/api/auth/login', (req, res) => {
  const { id, password, role } = req.body;
  const user = db.users.find(u => u.id === id && u.password === password && u.role === role);
  if (user) {
    res.json({ status: "SUCCESS", user: { id: user.id, name: user.name, role: user.role } });
  } else {
    res.status(401).json({ error: "Invalid Credentials or Role Mismatch." });
  }
});

// -----------------------------------------------------------------------------
// ADMIN APIs
// -----------------------------------------------------------------------------
// Create New Election
app.post('/api/admin/elections', (req, res) => {
  const { title, description, deadline } = req.body;
  if (!title || !deadline) return res.status(400).json({ error: "Title and Deadline are required." });

  const newElec = {
    id: 'elec-' + Date.now(),
    title,
    description: description || '',
    deadline,
    status: 'OPEN'
  };
  db.elections.push(newElec);
  saveDB();
  res.json({ status: "SUCCESS", election: newElec });
});

// Toggle Election Status (OPEN / CLOSED)
app.post('/api/admin/elections/:id/toggle', (req, res) => {
  const elec = db.elections.find(e => e.id === req.params.id);
  if (!elec) return res.status(404).json({ error: "Election not found." });

  elec.status = elec.status === 'OPEN' ? 'CLOSED' : 'OPEN';
  saveDB();
  res.json({ status: "SUCCESS", election: elec });
});

// Add New User (Student/Candidate)
app.post('/api/admin/users', (req, res) => {
  const { id, password, name, role } = req.body;
  if (!id || !password || !role) return res.status(400).json({ error: "ID, Password and Role are required." });

  if (db.users.find(u => u.id === id)) {
    return res.status(409).json({ error: "User ID already exists." });
  }

  const newUser = { id, password, name: name || id, role };
  db.users.push(newUser);
  saveDB();
  res.json({ status: "SUCCESS", user: newUser });
});

// Manage Candidate Nominations (ACCEPT / REJECT)
app.post('/api/admin/nominations/:id/review', (req, res) => {
  const { status } = req.body; // ACCEPTED or REJECTED
  const nom = db.nominations.find(n => n.id === req.params.id);
  if (!nom) return res.status(404).json({ error: "Nomination request not found." });

  nom.status = status;
  saveDB();
  res.json({ status: "SUCCESS", nomination: nom });
});

// -----------------------------------------------------------------------------
// CANDIDATE APIs
// -----------------------------------------------------------------------------
app.post('/api/candidate/nominate', (req, res) => {
  const { candidateId, candidateName, electionId, manifesto } = req.body;
  
  const election = db.elections.find(e => e.id === electionId);
  if (!election || election.status !== 'OPEN') {
    return res.status(400).json({ error: "Election is closed or invalid." });
  }

  const existing = db.nominations.find(n => n.candidateId === candidateId && n.electionId === electionId);
  if (existing) {
    return res.status(409).json({ error: "Nomination already submitted for this election." });
  }

  const newNomination = {
    id: 'nom-' + Date.now(),
    electionId,
    candidateId,
    candidateName,
    manifesto,
    status: 'PENDING'
  };
  db.nominations.push(newNomination);
  saveDB();
  res.json({ status: "SUCCESS", nomination: newNomination });
});

// -----------------------------------------------------------------------------
// STUDENT & VOTING APIs
// -----------------------------------------------------------------------------
// Fetch Public / Active Elections List
app.get('/api/elections', (req, res) => {
  res.json(db.elections);
});

// Fetch Approved Candidates for an Election
app.get('/api/elections/:id/candidates', (req, res) => {
  const approved = db.nominations
    .filter(n => n.electionId === req.params.id && n.status === 'ACCEPTED')
    .map(n => {
      const voteCount = db.votes.filter(v => v.electionId === req.params.id && v.candidateId === n.candidateId).length;
      return { candidateId: n.candidateId, name: n.candidateName, manifesto: n.manifesto, votes: voteCount };
    });
  res.json(approved);
});

// Cast Vote (Enforce One Vote Per Election Per Student)
app.post('/api/student/vote', (req, res) => {
  const { voterId, electionId, candidateId } = req.body;

  const election = db.elections.find(e => e.id === electionId);
  if (!election || election.status !== 'OPEN') {
    return res.status(403).json({ error: "This election is CLOSED or invalid." });
  }

  const alreadyVoted = db.votes.find(v => v.voterId === voterId && v.electionId === electionId);
  if (alreadyVoted) {
    return res.status(429).json({ error: "Access Denied: You have already voted in this specific election!" });
  }

  db.votes.push({
    voterId,
    electionId,
    candidateId,
    timestamp: new Date().toISOString()
  });
  saveDB();

  res.json({ status: "SUCCESS", message: "Your vote has been cast successfully!" });
});

// Dashboard Telemetry Stats
app.get('/api/stats', (req, res) => {
  res.json({
    totalUsers: db.users.length,
    totalElections: db.elections.length,
    totalNominations: db.nominations.length,
    pendingNominations: db.nominations.filter(n => n.status === 'PENDING').length,
    totalVotes: db.votes.length,
    rawNominations: db.nominations
  });
});

app.listen(PORT, () => {
  console.log(`\n=============================================================`);
  console.log(`[VOTONIC Engine Active] Running at http://localhost:${PORT}`);
  console.log(`=============================================================\n`);
});