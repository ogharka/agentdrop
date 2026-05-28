# AgentDrop 🤖
### Your AI airdrop farming platform on Base

An AI agent manages your wallet every day — farming airdrops, optimizing yield, and staying active on-chain. Users deposit USDC, set rules once, and get a morning report.

---

## What's in this project

```
agentdrop/
├── contracts/
│   └── AgentDrop.sol        ← Smart contract (the vault)
├── scripts/
│   └── deploy.js            ← Deploy the contract to Base
├── backend/
│   ├── server.js            ← AI agent + API server
│   └── package.json         ← Backend dependencies
├── hardhat.config.js        ← Blockchain config
├── .env.example             ← Copy this to .env and fill in
└── agentdrop-platform.html  ← The full frontend UI
```

---

## Setup guide (step by step)

### Step 1 — Copy the env file
Rename `.env.example` to `.env` and fill in your values.

You need:
- Your wallet private key (from MetaMask)
- Anthropic API key from https://console.anthropic.com
- Basescan API key from https://basescan.org/apis

### Step 2 — Install contract dependencies
```bash
npm install
npm install --save-dev hardhat@2.22.0 --legacy-peer-deps
npm install dotenv @openzeppelin/contracts --legacy-peer-deps
```

### Step 3 — Deploy the smart contract to Base testnet first
```bash
npx hardhat run scripts/deploy.js --network base-sepolia
```
Copy the contract address it gives you and paste it in your `.env` file.

### Step 4 — Deploy to Base mainnet (when ready)
```bash
npx hardhat run scripts/deploy.js --network base
```

### Step 5 — Start the backend
```bash
cd backend
npm install
npm start
```

The backend runs on http://localhost:3001

### Step 6 — Open the frontend
Just open `agentdrop-platform.html` in your browser.

---

## How it works

1. User signs up on the frontend
2. User deposits USDC into the smart contract vault
3. User sets rules (max gas, hold period, sell target)
4. Every day at 6:00 AM UTC the backend wakes up
5. For each user, it asks Claude AI what actions to take today
6. Claude reads the rules and decides (claim, swap, skip)
7. Backend executes approved actions via the smart contract
8. User gets a morning report

---

## Security

- Users keep full control of their funds
- Agent can only spend up to the user's daily limit
- Session keys expire every 24 hours
- User can pause or revoke agent access anytime
- Only whitelisted Base protocols are used

---

## Next steps to make it production-ready

- [ ] Add real protocol integrations (Aerodrome, Uniswap, Compound)
- [ ] Add email notifications for morning reports
- [ ] Add proper user authentication (JWT)
- [ ] Deploy backend to Railway or Render
- [ ] Deploy frontend to Vercel
- [ ] Add Stripe for subscription payments

---

Built on Base · Powered by Claude AI · MCP Architecture
