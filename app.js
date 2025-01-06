// Import the required modules
require('dotenv').config();
require('log-timestamp');
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { MongoClient } = require('mongodb');

// MongoDB Settings
const mongoUri = process.env.MONGO_URI;
const dbName = process.env.DB_NAME;
const collectionName = process.env.COLLECTION_NAME;

//For operations per second control, MongoDB Atlas plan limitation.
let operations = {start: 0, currentOp: 0, during:{start:0,end:0}, limit: 80};

// Express Settings
const app = express();
const port = process.env.SERVICE_PORT;

// CORS settings
app.use(cors({ origin: process.env.DOMAIN }));

// Array of operators
let OPERATORS = [];
let GLOBAL_DELEGATORS = [];

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
async function fetchOperators(page, limit) {
    try {		
		const response = await axios.get(`https://monitor.sophon.xyz/nodes?page=${i}&per_page=${limit}`);		
		return response.data.nodes;
    } catch (error) {
        console.error(`Erro ao consultar a API para o operador ${operatorAddress}:`, error.message);
        return null;
    }
}

async function paginateOperators(page, limit){	
	console.log('Updating operator indexes.');
	let operators_index = [];
	for(i=page;i<99999;i++){
		let response = await fetchOperators(i, limit);
		if(response.length > 0){
			operators_index.push(...response);
		}else{
			break;
		}
	}
	return operators_index;
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
	let delegators_temp = [];

    try {
	await operationControlCheck("init");
        await client.connect();
        console.log('Connected to MongoDB');

        const db = client.db(dbName);
        const collection = db.collection(collectionName);

        let idCounter = 0;
		await operationControlCheck("increment");
		OPERATORS = await paginateOperators(1,999);
		let total = OPERATORS.length;
		
		console.log(`${OPERATORS.length} Operators known`);

        for (const operator of OPERATORS) {
            // Database query
		await operationControlCheck("increment");
            const existingOperator = await collection.findOne({ operatorAddress: operator.operator });
			
			let operators_obj = {};

            // API Query
		await operationControlCheck("increment");
            const delegators = await fetchDelegators(operator.operator, idCounter++);
            if (delegators === null){
				console.log(`${idCounter}/${total} - RPC returns null for the operator: ${operator.operator}`);
				continue;
			} 

            if (existingOperator && (existingOperator.nodeStatus != operator.status || existingOperator.nodeRewards != operator.rewards || existingOperator.nodeFee != operator.fee || existingOperator.nodeUptime != operator.uptime || existingOperator.nodesDelegated != delegators)) {
                // Update existing document
		    await operationControlCheck("increment");
                await collection.updateOne(
                    { operatorAddress: operator.operator },
                    { $set: { nodesDelegated: delegators, nodeStatus: operator.status, nodeRewards: operator.rewards, nodeFee: operator.fee, nodeUptime: operator.uptime } }
                );
				upCounter++;
                console.log(`${idCounter}/${total} - Updated operator ${operator.operator} with ${delegators} delegators.`);
            } else if (!existingOperator) {
                // Inserts a new document
		    await operationControlCheck("increment");
                await collection.insertOne({
                    operatorAddress: operator.operator,
					nodesDelegated: delegators, 
					nodeStatus: operator.status, 
					nodeRewards: operator.rewards, 
					nodeFee: operator.fee, 
					nodeUptime: operator.uptime,
                });
				newCounter++;
                console.log(`${idCounter}/${total} - New operator inserted ${operator.operator} with ${delegators} delegators.`);
            }else{
				skipedCounter++;
				console.log(`${idCounter}/${total} - Operator ignored ${operator.operator} with ${delegators} delegators.`);
			}

            // delay between interactions
		await operationControlCheck("check");
            //await sleep(200);
        }
    } catch (error) {
        console.error('Error connecting or operating on MongoDB:', error.message);
    } finally {
		console.log(`${upCounter} Updated, ${newCounter} New Inserteds and ${skipedCounter} Ignored`);
	    	await operationControlCheck("finally");
		getAllOperators();
		setTimeout(updateOperators, process.env.REFRESH_INTERVAL * 1000); 
        await client.close();
    }
}

async function getAllOperators() {
	console.log(`Bringing existing delegate records by operator.`);
    const client = new MongoClient(mongoUri);

    try {
        await client.connect();
        console.log('Connected to MongoDB');

        const db = client.db(dbName);
        const collection = db.collection(collectionName);
        const operators_ = await collection.find({}, { projection: { _id: 0 } }).toArray();		
		
		
		GLOBAL_DELEGATORS = [];
        GLOBAL_DELEGATORS = {"nodes": operators_, lastupdate: Math.floor(Date.now() / 1000)};		

        console.log('GLOBAL_DELEGATORS Updated!');
		
        return GLOBAL_DELEGATORS;
    } catch (error) {
        console.error('Error connecting or operating on MongoDB:', error.message);
        return {};
    } finally {
        await client.close();
    }
}

async function operationControlCheck(cases){
	let timeNow = Math.floor(Date.now() / 1000);
	switch (cases) {
		case "init":
			operations.during.start = Math.floor(Date.now() / 1000);
			operations.during.end = 0;
			operations.start = Math.floor(Date.now() / 1000);
		break;
		case "increment":
			operations.currentOp++;			
			if((timeNow - operations.start) <= 1 && operations.currentOp >= operations.limit){
				console.log("Sleeping...");
				operations.currentOp = 0;
				await sleep(1000);
				operations.start = Math.floor(Date.now() / 1000);
			}else if((timeNow - operations.start) > 1 && operations.currentOp >= operations.limit){
				operations.start = Math.floor(Date.now() / 1000);
				operations.currentOp = 0;
			}
		break;
		case "check":			
			if((timeNow - operations.start) <= 1 && operations.currentOp >= operations.limit){
				console.log("Sleeping...");
				operations.currentOp = 0;
				await sleep(1000);
				operations.start = Math.floor(Date.now() / 1000);
			}else if((timeNow - operations.start) > 1 && operations.currentOp >= operations.limit){
				operations.start = Math.floor(Date.now() / 1000);
				operations.currentOp = 0;
			}
		break;
		case "finally":
			operations.during.end = timeNow;
			console.log(`Completed on: ${operations.during.end - operations.during.start}s`);
		break;
	}	
	return ;
}

// Route to get list of operators
app.get('/operators', async (req, res) => {
    try {
        res.json(GLOBAL_DELEGATORS);
    } catch (error) {
        res.status(500).json({ error: 'Error getting operators...' });
    }
});

// Start the server
app.listen(port, () => {
    console.log(`Server running on http://localhost:${port}`);
});

setTimeout(updateOperators, 5000);
getAllOperators();
