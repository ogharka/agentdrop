// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * AgentDrop Vault
 * Users deposit USDC. A trusted agent (MCP) can spend
 * up to the user's daily limit on their behalf.
 * Users can withdraw anytime. Agent can never exceed limits.
 */
contract AgentDrop is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable usdc;

    struct UserVault {
        uint256 balance;          // USDC balance (6 decimals)
        uint256 dailyLimit;       // Max USDC agent can spend per day
        uint256 spentToday;       // How much agent spent today
        uint256 lastResetDay;     // Day number of last reset
        bool agentEnabled;        // Is agent allowed to act
    }

    // user address => vault
    mapping(address => UserVault) public vaults;

    // Platform subscription: user => expiry timestamp
    mapping(address => uint256) public subscriptionExpiry;

    // Trusted agent address (our MCP backend)
    address public agentAddress;

    // Platform fee (monthly subscription in USDC, 6 decimals)
    uint256 public monthlyFee = 29 * 1e6; // $29 USDC

    // Events
    event Deposited(address indexed user, uint256 amount);
    event Withdrawn(address indexed user, uint256 amount);
    event AgentSpent(address indexed user, uint256 amount, string reason);
    event DailyLimitSet(address indexed user, uint256 limit);
    event AgentToggled(address indexed user, bool enabled);
    event Subscribed(address indexed user, uint256 expiry);

    constructor(address _usdc, address _agent) Ownable(msg.sender) {
        usdc = IERC20(_usdc);
        agentAddress = _agent;
    }

    // ── USER FUNCTIONS ──

    /// Deposit USDC into your vault
    function deposit(uint256 amount) external nonReentrant {
        require(amount > 0, "Amount must be > 0");
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        vaults[msg.sender].balance += amount;
        // Set default daily limit to 2% of deposit or $10, whichever is lower
        if (vaults[msg.sender].dailyLimit == 0) {
            uint256 autoLimit = (amount * 2) / 100;
            vaults[msg.sender].dailyLimit = autoLimit < 10 * 1e6 ? autoLimit : 10 * 1e6;
        }
        emit Deposited(msg.sender, amount);
    }

    /// Withdraw any amount from your vault anytime
    function withdraw(uint256 amount) external nonReentrant {
        require(vaults[msg.sender].balance >= amount, "Insufficient balance");
        vaults[msg.sender].balance -= amount;
        usdc.safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
    }

    /// Set your daily spending limit for the agent
    function setDailyLimit(uint256 limit) external {
        require(limit <= 100 * 1e6, "Max limit is $100/day");
        vaults[msg.sender].dailyLimit = limit;
        emit DailyLimitSet(msg.sender, limit);
    }

    /// Enable or pause your agent
    function setAgentEnabled(bool enabled) external {
        vaults[msg.sender].agentEnabled = enabled;
        emit AgentToggled(msg.sender, enabled);
    }

    /// Subscribe for one month
    function subscribe() external nonReentrant {
        require(vaults[msg.sender].balance >= monthlyFee, "Insufficient balance for subscription");
        vaults[msg.sender].balance -= monthlyFee;
        // Extend from current expiry or now
        uint256 start = subscriptionExpiry[msg.sender] > block.timestamp
            ? subscriptionExpiry[msg.sender]
            : block.timestamp;
        subscriptionExpiry[msg.sender] = start + 30 days;
        // Send fee to platform owner
        usdc.safeTransfer(owner(), monthlyFee);
        emit Subscribed(msg.sender, subscriptionExpiry[msg.sender]);
    }

    // ── AGENT FUNCTIONS ──

    /// Agent spends USDC on behalf of user (gas, micro-swaps etc)
    function agentSpend(address user, uint256 amount, string calldata reason)
        external
        nonReentrant
    {
        require(msg.sender == agentAddress, "Only agent");
        require(vaults[user].agentEnabled, "Agent not enabled");
        require(isSubscribed(user), "Subscription expired");
        require(vaults[user].balance >= amount, "Insufficient balance");

        // Reset daily counter if new day
        uint256 today = block.timestamp / 1 days;
        if (vaults[user].lastResetDay < today) {
            vaults[user].spentToday = 0;
            vaults[user].lastResetDay = today;
        }

        require(
            vaults[user].spentToday + amount <= vaults[user].dailyLimit,
            "Daily limit exceeded"
        );

        vaults[user].balance -= amount;
        vaults[user].spentToday += amount;
        usdc.safeTransfer(agentAddress, amount);

        emit AgentSpent(user, amount, reason);
    }

    // ── VIEW FUNCTIONS ──

    function isSubscribed(address user) public view returns (bool) {
        return subscriptionExpiry[user] > block.timestamp;
    }

    function getUserVault(address user) external view returns (
        uint256 balance,
        uint256 dailyLimit,
        uint256 spentToday,
        bool agentEnabled,
        bool subscribed
    ) {
        UserVault memory v = vaults[user];
        return (
            v.balance,
            v.dailyLimit,
            v.spentToday,
            v.agentEnabled,
            isSubscribed(user)
        );
    }

    function remainingTodayLimit(address user) external view returns (uint256) {
        UserVault memory v = vaults[user];
        uint256 today = block.timestamp / 1 days;
        uint256 spent = v.lastResetDay < today ? 0 : v.spentToday;
        return v.dailyLimit > spent ? v.dailyLimit - spent : 0;
    }

    // ── OWNER FUNCTIONS ──

    function setAgentAddress(address _agent) external onlyOwner {
        agentAddress = _agent;
    }

    function setMonthlyFee(uint256 fee) external onlyOwner {
        monthlyFee = fee;
    }
}
