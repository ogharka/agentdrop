// backend/server.js
// This is the backend that manages users, rules, and triggers the AI agent daily

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const cron = require("node-cron");
const { ethers } = require("ethers");
const Anthropic = require("@anthropic-ai/sdk");

const app = express();
app.use(cors());
app.use(express.json());

// ── DATABASE (simple JSON file for now) ──
const fs = require("fs");
const DB_FILE = "./db.json";

function readDB() {
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify({ users: {} }));
  }
  return JSON.parse(fs.readFileSync(DB_FILE));
}

function writeDB(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

// ── CONTRACT SETUP ──
const CONTRACT_ABI = [
  "function getUserVault(address user) view returns (uint256 balance, uint256 dailyLimit, uint256 spentToday, bool agentEnabled, bool subscribed)",
  "function remainingTodayLimit(address user) view returns (uint256)",
  "function agentSpend(address user, uint256 amount, string reason) external",
  "function isSubscribed(address user) view returns (bool)",
];

const provider = new ethers.JsonRpcProvider("https://mainnet.base.org");
const agentWallet = new ethers.Wallet(process.env.AGENT_PRIVATE_KEY, provider);
const contract = new ethers.Contract(
  process.env.CONTRACT_ADDRESS,
  CONTRACT_ABI,
  agentWallet
);

// ── ANTHROPIC CLIENT ──
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── API ROUTES ──

// Register a new user
app.post("/api/register", async (req, res) => {
  const { email, password, walletAddress, plan, rules } = req.body;
  const db = readDB();

  if (db.users[email]) {
    return res.status(400).json({ error: "User already exists" });
  }

  db.users[email] = {
    email,
    password, // In production: hash this with bcrypt
    walletAddress,
    plan: plan || "pro",
    rules: rules || getDefaultRules(),
    createdAt: new Date().toISOString(),
    activityLog: [],
    totalEarned: 0,
  };

  writeDB(db);
  res.json({ success: true, message: "Account created!" });
});

// Login
app.post("/api/login", (req, res) => {
  const { email, password } = req.body;
  const db = readDB();
  const user = db.users[email];

  if (!user || user.password !== password) {
    return res.status(401).json({ error: "Invalid credentials" });
  }

  res.json({ success: true, user: { email, walletAddress: user.walletAddress, plan: user.plan, rules: user.rules } });
});

// Get user dashboard data
app.get("/api/dashboard/:email", async (req, res) => {
  const db = readDB();
  const user = db.users[req.params.email];
  if (!user) return res.status(404).json({ error: "User not found" });

  try {
    // Get on-chain vault data
    const vault = await contract.getUserVault(user.walletAddress);
    const remaining = await contract.remainingTodayLimit(user.walletAddress);

    res.json({
      user: {
        email: user.email,
        walletAddress: user.walletAddress,
        plan: user.plan,
        rules: user.rules,
      },
      vault: {
        balance: ethers.formatUnits(vault.balance, 6),
        dailyLimit: ethers.formatUnits(vault.dailyLimit, 6),
        spentToday: ethers.formatUnits(vault.spentToday, 6),
        agentEnabled: vault.agentEnabled,
        subscribed: vault.subscribed,
        remainingToday: ethers.formatUnits(remaining, 6),
      },
      activityLog: user.activityLog.slice(-20), // Last 20 actions
      totalEarned: user.totalEarned,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update user rules
app.post("/api/rules/:email", (req, res) => {
  const db = readDB();
  const user = db.users[req.params.email];
  if (!user) return res.status(404).json({ error: "User not found" });

  db.users[req.params.email].rules = req.body.rules;
  writeDB(db);
  res.json({ success: true });
});

// ── AI AGENT LOGIC ──

function getDefaultRules() {
  return {
    maxGasPerAction: 2.0,       // Max $2 gas per action
    holdDays: 14,               // Hold tokens for 14 days
    sellTargetPercent: 30,      // Sell at +30% profit
    dailyActivitySwap: true,    // Do 1 small swap daily
    dailyActivityAmount: 5,     // $5 activity swap
    maxDailySpend: 10,          // Max $10/day total
    minClaimValue: 5,           // Min $5 to bother claiming
  };
}

async function runAgentForUser(email, user) {
  console.log(`\n🤖 Running agent for ${email}...`);

  try {
    // Check vault on-chain
    const vault = await contract.getUserVault(user.walletAddress);
    if (!vault.agentEnabled) {
      console.log(`  ⏸ Agent disabled for ${email}`);
      return;
    }
    if (!vault.subscribed) {
      console.log(`  ❌ Subscription expired for ${email}`);
      return;
    }

    const balance = parseFloat(ethers.formatUnits(vault.balance, 6));
    const remaining = parseFloat(ethers.formatUnits(
      await contract.remainingTodayLimit(user.walletAddress), 6
    ));

    if (remaining <= 0) {
      console.log(`  💰 Daily limit reached for ${email}`);
      return;
    }

    // Ask Claude what to do today
    const agentDecision = await askClaudeAgent(user, balance, remaining);
    console.log(`  🧠 Claude decision:`, agentDecision.summary);

    // Execute the actions Claude decided
    const log = [];
    for (const action of agentDecision.actions) {
      const result = await executeAction(user, action, remaining);
      log.push(result);
      if (result.earned) user.totalEarned += result.earned;
    }

    // Save activity log
    const db = readDB();
    db.users[email].activityLog = [
      ...log,
      ...(db.users[email].activityLog || []),
    ].slice(0, 100); // Keep last 100
    db.users[email].totalEarned = user.totalEarned;
    writeDB(db);

    console.log(`  ✅ Agent done for ${email}. ${log.length} actions taken.`);
    return log;

  } catch (err) {
    console.error(`  ❌ Agent error for ${email}:`, err.message);
  }
}

async function askClaudeAgent(user, balance, remainingLimit) {
  const rules = user.rules || getDefaultRules();

  const prompt = `You are an AI agent managing a crypto wallet on Base blockchain.

WALLET STATE:
- USDC Balance: $${balance}
- Remaining daily spend limit: $${remainingLimit}
- Wallet address: ${user.walletAddress}

USER RULES:
- Max gas per action: $${rules.maxGasPerAction}
- Hold tokens for: ${rules.holdDays} days before selling
- Sell target: +${rules.sellTargetPercent}% profit
- Daily activity swap: ${rules.dailyActivitySwap ? "Yes, $" + rules.dailyActivityAmount : "No"}
- Min claim value: $${rules.minClaimValue}

AVAILABLE ACTIONS ON BASE TODAY:
1. Claim Aerodrome AERO rewards (est. value: $84.20, gas: $0.03)
2. Claim Base Ecosystem tokens (est. value: $42.60, gas: $0.04)  
3. Daily activity swap USDC→ETH ($5, gas: $0.02) - maintains on-chain score
4. Check Compound USDC yield position (no gas needed)

Decide which actions to take TODAY based on the rules. Be conservative and safe.
Respond in JSON only:
{
  "summary": "one sentence of what you decided",
  "actions": [
    { "type": "claim", "protocol": "Aerodrome", "estimatedValue": 84.20, "gasCost": 0.03, "reason": "..." },
    { "type": "swap", "from": "USDC", "to": "ETH", "amount": 5, "gasCost": 0.02, "reason": "..." }
  ]
}`;

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1000,
    messages: [{ role: "user", content: prompt }],
  });

  const text = response.content[0].text;
  const clean = text.replace(/```json|```/g, "").trim();
  return JSON.parse(clean);
}

async function executeAction(user, action, remainingLimit) {
  const gasCost = action.gasCost || 0;

  // Safety check: don't exceed limit
  if (gasCost > remainingLimit) {
    return {
      type: action.type,
      protocol: action.protocol || "Unknown",
      status: "skipped",
      reason: `Gas $${gasCost} exceeds remaining limit $${remainingLimit.toFixed(2)}`,
      timestamp: new Date().toISOString(),
    };
  }

  if (gasCost > (user.rules?.maxGasPerAction || 2)) {
    return {
      type: action.type,
      protocol: action.protocol || "Unknown",
      status: "skipped",
      reason: `Gas $${gasCost} exceeds your $${user.rules?.maxGasPerAction} limit`,
      timestamp: new Date().toISOString(),
    };
  }

  // In production: actually call the protocol contracts here
  // For now: simulate the action and record it
  const gasInUsdc = Math.round(gasCost * 1e6);

  try {
    if (gasInUsdc > 0) {
      // Deduct gas from vault via smart contract
      await contract.agentSpend(
        user.walletAddress,
        gasInUsdc,
        `${action.type}: ${action.protocol || action.from + "→" + action.to}`
      );
    }

    return {
      type: action.type,
      protocol: action.protocol || `${action.from}→${action.to}`,
      status: "success",
      earned: action.estimatedValue || 0,
      gasCost: gasCost,
      reason: action.reason,
      timestamp: new Date().toISOString(),
    };
  } catch (err) {
    return {
      type: action.type,
      protocol: action.protocol || "Unknown",
      status: "failed",
      error: err.message,
      timestamp: new Date().toISOString(),
    };
  }
}

// ── DAILY CRON JOB ──
// Runs every day at 6:00 AM UTC
cron.schedule("0 6 * * *", async () => {
  console.log("\n⏰ Daily agent run starting...", new Date().toISOString());
  const db = readDB();

  for (const [email, user] of Object.entries(db.users)) {
    await runAgentForUser(email, user);
    // Small delay between users
    await new Promise(r => setTimeout(r, 2000));
  }

  console.log("✅ Daily run complete.");
});

// Manual trigger for testing
app.post("/api/run-agent/:email", async (req, res) => {
  const db = readDB();
  const user = db.users[req.params.email];
  if (!user) return res.status(404).json({ error: "User not found" });

  const log = await runAgentForUser(req.params.email, user);
  res.json({ success: true, actions: log });
});

// Health check
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", time: new Date().toISOString() });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`\n🚀 AgentDrop backend running on port ${PORT}`);
  console.log(`Agent wallet: ${agentWallet.address}`);
});
