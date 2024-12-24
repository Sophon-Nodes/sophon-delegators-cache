// Import the required modules
require('dotenv').config();
require('log-timestamp');
const axios = require('axios');
const { MongoClient } = require('mongodb');

// MongoDB Settings
const mongoUri = process.env.MONGO_URI;
const dbName = process.env.DB_NAME;
const collectionName = process.env.COLLECTION_NAME;


// Array of operators
let OPERATORS = [];

// Function to compose the "data" field of the request
function composeData(operatorAddress) {
    const functionHex = '0x45200b90'; // Hexadecimal function name
    const paddedAddress = operatorAddress.toLowerCase().padStart(64, '0').replace("x","0");
    const constant = '2'.padStart(64, '0');
    return `${functionHex}${paddedAddress}${constant}`;
}

// Function to convert a hexadecimal value to an integer
function hexToInt(hex) {
    return parseInt(hex, 16);
}

// Function to query the API
async function fetchOperators() {
    try {
        const response = await axios.get('https://monitor.sophon.xyz/nodes');
		
		return response.data.nodes;
    } catch (error) {
        console.error(`Erro ao consultar a API para o operador ${operatorAddress}:`, error.message);
        return null;
    }
}

// Function to query the API
async function fetchDelegators(operatorAddress, id) {
    const payload = {
        method: 'eth_call',
        params: [
            {
                to: '0xd8e3a935706c08b5e6f8e05d63d3e67ce2ae330c',
                data: composeData(operatorAddress),
            }
        ],
        id: id,
        jsonrpc: '2.0',
    };	
	

    try {
        const response = await axios.post(process.env.RPC_SOPHON, payload);
		if (response.data.error) {
            console.error(`Erro na API para o operador ${operatorAddress}:`, response.data.error.code, response.data.error.message, response.data.error.data);
            return null;
        }
		
        return hexToInt(response.data.result);
    } catch (error) {
        console.error(`Erro ao consultar a API para o operador ${operatorAddress}:`, error.message);
        return null;
    }
}

// Function to add a delay
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Main function to update or insert data in MongoDB
async function updateOperators() {
    const client = new MongoClient(mongoUri);
	let upCounter = 0;
	let newCounter = 0;
	let skipedCounter = 0;

    try {
        await client.connect();
        console.log('Connected to MongoDB');

        const db = client.db(dbName);
        const collection = db.collection(collectionName);

        let idCounter = 0;
		
		OPERATORS = await fetchOperators();
		let total = OPERATORS.length;
		
		console.log(`${OPERATORS.length} Operators known`);

        for (const operator of OPERATORS) {
            // Database query
            const existingOperator = await collection.findOne({ operatorAddress: operator.operator });

            // API Query
            const delegators = await fetchDelegators(operator.operator, idCounter++);
            if (delegators === null){
				console.log(`${idCounter}/${total} - RPC returns null for the operator: ${operator.operator}`);
				continue;
			} 

            if (existingOperator && existingOperator.nodesDelegated != delegators) {
                // Update existing document
                await collection.updateOne(
                    { operatorAddress: operator.operator },
                    { $set: { nodesDelegated: delegators } }
                );
				upCounter++;
                console.log(`${idCounter}/${total} - Updated operator ${operator.operator} with ${delegators} delegators.`);
            } else if (!existingOperator) {
                // Inserts a new document
                await collection.insertOne({
                    operatorAddress: operator.operator,
                    nodesDelegated: delegators,
                });
				newCounter++;
                console.log(`${idCounter}/${total} - New operator inserted ${operator.operator} with ${delegators} delegators.`);
            }else{
				skipedCounter++;
				console.log(`${idCounter}/${total} - Operator ignored ${operator.operator} with ${delegators} delegators.`);
			}

            // delay between interactions
            await sleep(200);
        }
    } catch (error) {
        console.error('Error connecting or operating on MongoDB:', error.message);
    } finally {
		console.log(`${upCounter} Updated, ${newCounter} New Inserteds and ${skipedCounter} Ignored`);
		setTimeout(updateOperators, 1800000); //every 15 minutes
        await client.close();
    }
}

// Function to run periodically
//setInterval(updateOperators, 60000); // Updates every 60 seconds

// Run the function when starting the script
updateOperators();

//fetchDelegators(OPERATORS[0],1);
