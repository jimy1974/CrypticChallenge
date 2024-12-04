// server.js
require('dotenv').config();
const express = require('express');
const path = require('path');
const OpenAI = require('openai');
const session = require('express-session');
const crypto = require('crypto');

// Stellar configuration
const StellarSdk = require('stellar-sdk');
const stellarServer = new StellarSdk.Horizon.Server('https://horizon.stellar.org');
const platformWalletAddress = 'GC7OC7AJW6K7NMCUCPRQEZQWMGGQTF5DQQZPWH5CQ4TSI5JVD5RQNCLP';

const app = express();
const PORT = process.env.PORT || 3000;

// OpenAI Configuration
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Session middleware
app.use(session({
    secret: 'oledfrtbnhjuik',
    resave: false,
    saveUninitialized: true,
}));

// Initialize game state in session
app.use((req, res, next) => {
    if (!req.session.gameState) {
        req.session.gameState = {
            balance: 20,
            currentDifficulty: 1, // Set to medium by default
            totalWinnings: 0,     // Initialize total winnings
        };
    }
    next();
});


// Existing middleware
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Game State Management
class CrypticCluesGame {
    constructor(state = {}) {
        this.balance = state.balance || 20;
        this.difficulties = ["easy", "medium", "hard", "very hard"];
        this.currentDifficulty = state.currentDifficulty || 1; // Default to medium
        this.totalWinnings = state.totalWinnings || 0;         // Initialize total winnings
    }


    async generateClue(difficultyLevel = this.currentDifficulty) {
        const difficultyName = this.difficulties[difficultyLevel];

        try {
            const response = await openai.chat.completions.create({
                model: "gpt-4",
                messages: [
                    {
                        role: "system",
                        content: "You are a cryptic clue generator."
                    },
                    {
                        role: "user",
                        content: `Create a ${difficultyName} cryptic clue. Include the clue, answer, and a brief explanation. Please format your response exactly as:

Clue: [Your Clue]

Answer: [Answer]

Explanation: [Explanation]

Do not include any additional text and AVOID ANAGRAMS ENTIRELY. Do not rearrange letters to create words.`
                    }
                ],
                max_tokens: 300,
                temperature: 0.7
            });

            const content = response.choices[0].message.content;

            // Extract the clue, answer, and explanation
            const clueMatch = content.match(/Clue:\s*(.+?)(?=\nAnswer:)/s);
            const answerMatch = content.match(/Answer:\s*(.+?)(?=\nExplanation:)/s);
            const explanationMatch = content.match(/Explanation:\s*(.+)/s);

            return {
                clue: clueMatch ? clueMatch[1].trim() : content,
                answer: answerMatch ? answerMatch[1].trim() : "N/A",
                explanation: explanationMatch ? explanationMatch[1].trim() : "No explanation provided."
            };
        } catch (error) {
            console.error("Clue generation error:", error);
            return null;
        }
    }

    processAnswer(isCorrect) {
        const questionCost = 1;
        let prizePool = 0;

        if (isCorrect) {
            this.balance -= questionCost;
            prizePool = this.getPayoutMultiplier() * 2; // Assuming a 2 XLM bet
            this.totalWinnings += prizePool; // Accumulate winnings
        } else {
            this.balance += questionCost;
        }

        console.log('Game State:', {
            balance: this.balance,
            difficulty: this.difficulties[this.currentDifficulty],
            prizePool: prizePool,
            totalWinnings: this.totalWinnings,
        });

        return {
            balance: this.balance,
            difficulty: this.difficulties[this.currentDifficulty],
            prizePool: prizePool,
            totalWinnings: this.totalWinnings,
        };
    }


    getPayoutMultiplier() {
        const difficulty = this.difficulties[this.currentDifficulty];
        const payoutMultipliers = {
            'easy': 2,
            'medium': 5,
            'hard': 10,
            'very hard': 50
        };
        return payoutMultipliers[difficulty] || 1;
    }
}

// Routes
app.get('/', async (req, res) => {
    try {
        const account = await stellarServer.accounts().accountId(platformWalletAddress).call();
        const balance = parseFloat(account.balances.find(b => b.asset_type === 'native').balance);
        const payout = (balance * 0.05).toFixed(2);
        res.render('index', { balance: balance.toFixed(2), payout });
    } catch (error) {
        console.error('Error fetching wallet balance:', error);
        res.render('index', { balance: 'Error', payout: 'Error' });
    }
});

app.get('/start', async (req, res) => {
    const game = new CrypticCluesGame(req.session.gameState);

    const question = await game.generateClue();
    try {
        const account = await stellarServer.accounts().accountId(platformWalletAddress).call();
        const balance = parseFloat(account.balances.find(b => b.asset_type === 'native').balance).toFixed(2);

        // Store the correct answer and explanation in the session
        req.session.correctAnswer = question.answer;
        req.session.explanation = question.explanation;

        // Update the game state in the session
        req.session.gameState.currentDifficulty = game.currentDifficulty;

        console.log("Correct Answer:", req.session.correctAnswer);
        console.log("Explanation:", req.session.explanation);

        res.render('game', {
            clue: question.clue,
            balance,
            difficulty: game.difficulties[game.currentDifficulty],
        });
    } catch (error) {
        console.error('Error fetching wallet balance:', error);
        res.render('game', {
            clue: question.clue,
            balance: 'Error',
            difficulty: game.difficulties[game.currentDifficulty],
        });
    }
});

app.get('/reset', (req, res) => {
    req.session.destroy();
    res.redirect('/start');
});

app.post('/submit', async (req, res) => {
    const { userAnswer } = req.body;
    console.log("User Answer:", userAnswer);

    // Retrieve the correct answer from the session
    const correctAnswer = req.session.correctAnswer;

    // Validate the answer and get explanation
    const { isCorrect, explanation } = await checkAnswerAndExplain(userAnswer, correctAnswer);

    // Create game instance with session state
    const game = new CrypticCluesGame(req.session.gameState);

    // Process the result
    const gameState = game.processAnswer(isCorrect);

    // Update the game state in the session
    req.session.gameState.balance = gameState.balance;
    req.session.gameState.totalWinnings = gameState.totalWinnings;

    // Fetch the actual wallet balance
    let balance;
    try {
        const account = await stellarServer.accounts().accountId(platformWalletAddress).call();
        balance = parseFloat(account.balances.find(b => b.asset_type === 'native').balance).toFixed(2);
    } catch (error) {
        console.error('Error fetching wallet balance:', error);
        balance = 'Error';
    }

    res.render('result', {
        isCorrect,
        userAnswer,
        correctAnswer,
        explanation,
        balance,
        difficulty: gameState.difficulty,
        prizePool: gameState.prizePool,
        gameState, // Pass the entire gameState
    });

});






// Route to generate payment details
app.post('/generate-payment', (req, res) => {
    const { userMessage } = req.body;

    if (!userMessage) {
        console.error('User message is undefined or missing.');
        res.status(400).json({ error: 'User message is required.' });
        return;
    }

    // Generate a unique memo
    const memo = crypto.randomBytes(8).toString('hex');

    // Log the memo and message for debugging
    console.log(`Generated Memo: ${memo} for Message: ${userMessage}`);

    // Return payment details to the frontend
    res.json({
        walletAddress: platformWalletAddress,
        memo,
        message: userMessage
    });
});


// Add this function to check answer similarity using OpenAI
// server.js

async function checkAnswerAndExplain(userAnswer, correctAnswer) {

    // Function to normalize answers (lowercase and trim whitespace)
    function normalizeAnswer(answer) {
        return answer.toLowerCase().trim();
    }

    // Normalize both user's answer and correct answer
    const userAnswerNormalized = normalizeAnswer(userAnswer);
    const correctAnswerNormalized = normalizeAnswer(correctAnswer);

    try {
        // Call OpenAI API to check if the answers are equivalent
        const response = await openai.chat.completions.create({
            model: "gpt-4",
            messages: [
                {
                    role: "system",
                    content: "You are an assistant that checks if a user's answer to a cryptic clue is correct. Respond with 'CORRECT' or 'INCORRECT' followed by a brief explanation."
                },
                {
                    role: "user",
                    content: `User's Answer: "${userAnswerNormalized}"\nCorrect Answer: "${correctAnswerNormalized}"\nIs the user's answer correct?`
                }
            ],
            max_tokens: 100,
            temperature: 0.7
        });

        // Extract the assistant's response
        const content = response.choices[0].message.content.trim();

        // Determine if the answer is correct
        const isCorrect = content.toUpperCase().startsWith('CORRECT');

        // Extract the explanation
        const explanation = content.replace(/^CORRECT:?\s*|^INCORRECT:?\s*/i, '').trim();

        return { isCorrect, explanation };
    } catch (error) {
        console.error("Answer checking error:", error);

        // Fallback to exact match using normalized answers
        const isCorrect = userAnswerNormalized === correctAnswerNormalized;
        const explanation = isCorrect ? 'Your answer matches the correct answer.' : 'Your answer does not match the correct answer.';

        return { isCorrect, explanation };
    }
}





async function monitorPayments(memo) {
    console.log(`Monitoring payments for Memo: ${memo}`);

    // Monitor the Stellar network for transactions
    stellarServer.transactions()
        .forAccount(platformWalletAddress)
        .call()
        .then(response => {
            const validTransactions = response.records.filter(tx => tx.memo === memo && tx.amount === '1.0000000');
            
            if (validTransactions.length > 0) {
                console.log(`Payment received for Memo: ${memo}`);
                // Process the user's message here
                processUserMessage(memo);
            } else {
                console.log('No matching payment found yet.');
            }
        })
        .catch(err => console.error('Error monitoring payments:', err));
}

// Dummy function to process the user's message
function processUserMessage(memo) {
    console.log(`Processing message for Memo: ${memo}`);
    // Add your logic to handle the message, such as storing it or displaying it
}




app.get('/confirm-payment', async (req, res) => {
    const { memo } = req.query;

    try {
        // Fetch transactions for the platform wallet
        const payments = await stellarServer.payments()
            .forAccount(platformWalletAddress)
            .order('desc')
            .limit(10)
            .call();

        // Log payments for debugging
        console.log('Payments retrieved:', payments.records);

        // Find the payment with the matching memo
        const validPayment = payments.records.find(payment =>
            payment.memo === memo &&
            payment.type === 'payment' &&
            payment.asset_type === 'native' &&
            payment.amount === '2.0000000' // Adjust as needed
        );

        if (validPayment) {
            console.log(`Payment confirmed for Memo: ${memo}`);

            // Store the sender's address in the session
            req.session.senderAddress = validPayment.from;
            console.log(`Sender's Address: ${req.session.senderAddress}`);

            res.json({ status: 'success' });
        } else {
            console.log(`Payment not found for Memo: ${memo}`);
            res.json({ status: 'pending' });
        }
    } catch (error) {
        console.error('Error checking payment:', error);
        res.status(500).json({ status: 'error' });
    }
});




app.get('/withdraw', async (req, res) => {
    const game = new CrypticCluesGame(req.session.gameState);

    // Check if the user has winnings to withdraw
    if (game.totalWinnings <= 0) {
        return res.redirect('/start');
    }

    // Get the sender's address from the session
    const defaultAddress = req.session.senderAddress;

    res.render('withdraw', {
        totalWinnings: game.totalWinnings,
        defaultAddress,
    });
});

/*
app.post('/process-withdrawal', async (req, res) => {
    const { walletAddress } = req.body;
    const game = new CrypticCluesGame(req.session.gameState);

    if (game.totalWinnings <= 0) {
        return res.redirect('/start');
    }

    // Implement logic to send the XLM to the user's wallet address
    // For now, we'll simulate the payment

    try {
        // Simulate payment processing
        console.log(`Processing withdrawal of ${game.totalWinnings} XLM to wallet ${walletAddress}`);

        // Reset the user's winnings after successful withdrawal
        game.totalWinnings = 0;
        req.session.gameState.totalWinnings = 0;

        res.render('withdrawal-success', {
            walletAddress,
            amount: game.totalWinnings,
        });
    } catch (error) {
        console.error('Withdrawal error:', error);
        res.render('withdrawal-failure', {
            message: 'An error occurred while processing your withdrawal. Please try again later.',
        });
    }
});*/



//Working withdrawal

app.post('/process-withdrawal', async (req, res) => {
    let { walletAddress } = req.body;
    const game = new CrypticCluesGame(req.session.gameState);

    if (game.totalWinnings <= 0) {
        return res.redirect('/start');
    }

    // Validate the wallet address
    if (!StellarSdk.StrKey.isValidEd25519PublicKey(walletAddress)) {
        return res.render('withdrawal-failure', {
            message: 'Invalid Stellar wallet address. Please check and try again.',
        });
    }
    
    try {
        // Load platform account
        const platformKeypair = StellarSdk.Keypair.fromSecret(process.env.PLATFORM_SECRET_KEY);
        const platformAccount = await stellarServer.loadAccount(platformKeypair.publicKey());

        // Create transaction to send winnings to user's wallet
        const transaction = new StellarSdk.TransactionBuilder(platformAccount, {
            fee: StellarSdk.BASE_FEE,
            networkPassphrase: StellarSdk.Networks.PUBLIC,
        })
            .addOperation(StellarSdk.Operation.payment({
                destination: walletAddress,
                asset: StellarSdk.Asset.native(),
                amount: game.totalWinnings.toString(),
            }))
            .setTimeout(30)
            .build();

        // Sign the transaction
        transaction.sign(platformKeypair);

        // Submit the transaction
        const transactionResult = await stellarServer.submitTransaction(transaction);
        console.log('Withdrawal transaction successful:', transactionResult);

        // Reset the user's winnings after successful withdrawal
        game.totalWinnings = 0;
        req.session.gameState.totalWinnings = 0;

        res.render('withdrawal-success', {
            walletAddress,
            amount: game.totalWinnings,
        });
    } catch (error) {
        console.error('Withdrawal error:', error.response.data.extras.result_codes);
        res.render('withdrawal-failure', {
            message: 'An error occurred while processing your withdrawal. Please try again later.',
        });
    }
});



// server.js
app.get('/change-difficulty', async (req, res) => {
    const difficulty = req.query.difficulty; // e.g., 'medium'
    const game = new CrypticCluesGame(req.session.gameState);

    // Update the currentDifficulty in the game
    const difficultyIndex = game.difficulties.indexOf(difficulty);
    if (difficultyIndex !== -1) {
        game.currentDifficulty = difficultyIndex;
    } else {
        game.currentDifficulty = game.difficulties.indexOf('medium');
    }

    // Generate a new clue with the selected difficulty
    const question = await game.generateClue();

    // Store the correct answer and explanation in the session
    req.session.correctAnswer = question.answer;
    req.session.explanation = question.explanation;

    // Update the game state in the session
    req.session.gameState.currentDifficulty = game.currentDifficulty;

    res.json({
        clue: question.clue,
        payout: 2 * game.getPayoutMultiplier(),
    });
});






// Start Server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});