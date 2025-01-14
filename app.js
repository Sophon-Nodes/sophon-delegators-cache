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
const collectionOperators = process.env.COLLECTION_OPERATORS;
const collectionLogs = process.env.COLLECTION_LOGS;
const collectionSystem = process.env.COLLECTION_SYSTEM;

const DEBUG_MODE = false;

//For operations per second control, MongoDB Atlas plan limitation.
let operations = {start: 0, currentOp: 0, during:{start:0,end:0}, limit: 80};

let updateOperations = {newRecord: 0, updateRecord: 0, recordIgnored: 0, noAction: 0, recordErrors: 0};

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

// Function to convert an integer value to a hexadecimal
function intToHex(int) {
    return '0x' + int.toString(16);
}

//Convert to Ethereum Address
function toEthereumAddress(hexString) {
    const strippedHex = hexString.startsWith('0x') ? hexString.slice(2) : hexString;
    const address = strippedHex.slice(-40);
    return '0x' + address;
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
		
		if (response === null){
			console.error(`paginateOperators: Error during execution fetchOperators, loop terminated. `);
			return null;
		}
		
		await operationControlCheck("increment");
		if(response.length > 0){
			operators_index.push(...response);
			await operationControlCheck("check");
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
            console.error(`Function fetchDelegators:`, response.data.error.code, response.data.error.message, response.data.error.data);
            return null;
        }
		
        return hexToInt(response.data.result);
    } catch (error) {
        console.error(`Function fetchDelegators:`, error.message);
        return null;
    }
}

// Get logs on chain SOPHON
async function fetchLogs(bi, bf, id) {
    const payload = {
        method: 'eth_getLogs',
        params: [
            {
                "address": "0xd8e3a935706c08b5e6f8e05d63d3e67ce2ae330c",
                "fromBlock": intToHex(bi),
                "toBlock": intToHex(bf),
                "topics": [],
            }
        ],
        id: id,
        jsonrpc: '2.0',
    };	
	

    try {
        const response = await axios.post(process.env.RPC_SOPHON, payload);
		if (response.data.error) {
            console.error(`Function fetchLogs:`, response.data.error.code, response.data.error.message, response.data.error.data);
            return null;
        }
		
        return response.data.result;
    } catch (error) {
        console.error(`Function fetchLogs:`, error.message);
        return null;
    }
}

//Get lastblock on SOPHON
async function fetchLastBlock(id){
	const payload = {
        method: 'eth_blockNumber',
        params: [],
        id: id,
        jsonrpc: '2.0',
    };	
	

    try {
        const response = await axios.post(process.env.RPC_SOPHON, payload);
		if (response.data.error) {
            console.error(`Function fetchLastBlock:`, response.data.error.code, response.data.error.message, response.data.error.data);
            return null;
        }
		
        return hexToInt(response.data.result);
    } catch (error) {
        console.error(`Function fetchLastBlock:`, error.message);
        return null;
    }
}

//Save System Data
async function saveSystemData(newBlockNumber, lastBlockNumber){
	const client = new MongoClient(mongoUri);
	const db = client.db(dbName);
	const systemDataSet = db.collection(collectionSystem);
	
	try {
		await client.connect();
		const existingBlockInfo = await systemDataSet.findOne({});
		if(existingBlockInfo){
			await systemDataSet.updateOne(
                    { lastBlockNumber: existingBlockInfo.lastBlockNumber },
                    { $set: { lastBlockNumber: newBlockNumber, previousBlock: existingBlockInfo.lastBlockNumber, lastUpdate: Math.floor(Date.now() / 1000)} }
                );
		}else{
			await systemDataSet.insertOne({
				lastBlockNumber: newBlockNumber,
				previousBlock: lastBlockNumber,
				lastUpdate: Math.floor(Date.now() / 1000),
			});
		}		
	} catch (error) {
        console.error('Function saveSystemData Error connecting or operating on MongoDB:', error.message);
		return false;
    } finally { 
        await client.close();
		return true;
    }	
}

function getEventType(topic){
	if(topic == '0xd9a687098552b070e1e304af176b8a589970267356590b7c7386c2f4fb7d0cc8'){
		return "DELEGATE";			
	}else if(topic == '0x94784069b8ffa11f7392979bd35691ef746b2c02f3709f7112aae7e2b2f41f23'){
		return "UNDELEGATE";
	}else if(topic == '0x5e0927d844acaf1b5b3d6fc60c141645a4021a24d501dba971836d488277e084'){
		return "MINT";
		
	}else{
		return "Null";
	}
}

async function saveOnSyncMode(dataSet, log){
	try {
		if(log.topics.length != 3){
			if(DEBUG_MODE)
				console.log(`Ignoring... Transaction ${log.transactionHash} of ${hexToInt(log.blockNumber)} Already existing.`);
			return true;
		}		
		let typeEvent = getEventType(log.topics[0]);
		let guardian_ = toEthereumAddress(log.topics[1]);
		let operator_ = toEthereumAddress(log.topics[2]);
		
		if(typeEvent == "Null"){
			if(DEBUG_MODE)
				console.log(`Ignoring... ${log.topics[0]}`);
			return true;
		}else if(typeEvent == "MINT"){
			operator_ = 'Null';
		}
		
		const result = await dataSet.updateOne(
			{ blockNumber: hexToInt(log.blockNumber), txIndex: hexToInt(log.transactionIndex), txLogIndex: hexToInt(log.transactionLogIndex), eventType: typeEvent },
			{
				$set: { 
					txHash: log.transactionHash,
					blockHash: log.blockHash,
					blockTimestamp: hexToInt(log.blockTimestamp), 
					blockData: hexToInt(log.data), 
					logIndex: log.logIndex,
					guardian: guardian_,
					operator: operator_ 
				}
			},
			{ upsert: true }
		);

		if (result.upsertedCount > 0) {			
			updateOperations.newRecord++;
			if(DEBUG_MODE)
				console.log(`NEW! Transaction ${log.transactionHash} of ${hexToInt(log.blockNumber)}`);
		} else if (result.modifiedCount > 0) {			
			updateOperations.updateRecord++;
			if(DEBUG_MODE)
				console.log(`Updated... Transaction ${log.transactionHash} of ${hexToInt(log.blockNumber)} Already existing.`);
		} else if(result.matchedCount >= 1 && result.acknowledged) {			
			updateOperations.recordIgnored++;
			if(DEBUG_MODE)
				console.log(`Ignoring... Transaction ${log.transactionHash} of ${hexToInt(log.blockNumber)} Equal values.`);
		} else {			
			updateOperations.noAction++;
			if(DEBUG_MODE)
				console.log(`Not action... Transaction ${log.transactionHash} of ${hexToInt(log.blockNumber)}`);
		}
	} catch (error) {
        console.error('Function saveOnSyncMode Error connecting or operating on MongoDB:', error.message);
		updateOperations.recordErrors++;
    }
	return true;
}

//Save Logs Function
async function saveChainLogs(log){
	await operationControlCheck("increment");
	const client = new MongoClient(mongoUri);
	const db = client.db(dbName);
	const logsDataSet = db.collection(collectionLogs);
	
	try {
		await client.connect();
		if(log.topics.length != 3){
			if(DEBUG_MODE)
				console.log(`Ignoring... Transaction ${log.transactionHash} of ${hexToInt(log.blockNumber)} Already existing.`);
			await client.close();
			return true;
		}		
		let typeEvent = getEventType(log.topics[0]);
		let guardian_ = toEthereumAddress(log.topics[1]);
		let operator_ = toEthereumAddress(log.topics[2]);
		
		if(typeEvent == "Null"){
			if(DEBUG_MODE)
				console.log(`Ignoring... ${log.topics[0]}`);
			await client.close();
			return true;
		}else if(typeEvent == "MINT"){
			operator_ = 'Null';
		}
		
		await operationControlCheck("increment");
		/*let existingLog = await logsDataSet.findOne({ blockNumber: hexToInt(log.blockNumber), txIndex: hexToInt(log.transactionIndex), txLogIndex: hexToInt(log.transactionLogIndex), eventType: typeEvent });*/
		
		const result = await logsDataSet.updateOne(
			{ blockNumber: hexToInt(log.blockNumber), txIndex: hexToInt(log.transactionIndex), txLogIndex: hexToInt(log.transactionLogIndex), eventType: typeEvent },
			{
				$set: { 
					txHash: log.transactionHash,
					blockHash: log.blockHash,
					blockTimestamp: hexToInt(log.blockTimestamp), 
					blockData: hexToInt(log.data), 
					logIndex: log.logIndex,
					guardian: guardian_,
					operator: operator_ 
				}
			},
			{ upsert: true }
		);

		if (result.upsertedCount > 0) {			
			updateOperations.newRecord++;
			if(DEBUG_MODE)
				console.log(`NEW! Transaction ${log.transactionHash} of ${hexToInt(log.blockNumber)}`);
		} else if (result.modifiedCount > 0) {			
			updateOperations.updateRecord++;
			if(DEBUG_MODE)
				console.log(`Updated... Transaction ${log.transactionHash} of ${hexToInt(log.blockNumber)} Already existing.`);
		} else if(result.matchedCount >= 1 && result.acknowledged) {			
			updateOperations.recordIgnored++;
			if(DEBUG_MODE)
				console.log(`Ignoring... Transaction ${log.transactionHash} of ${hexToInt(log.blockNumber)} Equal values.`);
		} else {			
			updateOperations.noAction++;
			if(DEBUG_MODE)
				console.log(`Not action... Transaction ${log.transactionHash} of ${hexToInt(log.blockNumber)}`);
		}
	} catch (error) {		
		updateOperations.recordErrors++;
        console.error('Function saveChainLogs Error connecting or operating on MongoDB:', error.message);
		return false;
    } finally { 
        await client.close();
		return true;
    }	
}

//First cache routine.
async function getLogs(lastBlockNumber){
	await operationControlCheck("init");
	await operationControlCheck("increment");
	const lastBlock = await fetchLastBlock(1);
	let unit = process.env.LIMIT_OF_BLOCKS;
	let steps = 1;
	let logs = [];
	
	updateOperations.newRecord = 0;
	updateOperations.updateRecord = 0;
	updateOperations.recordIgnored = 0;
	updateOperations.noAction = 0;
	updateOperations.recordErrors = 0;
	
	if (lastBlock === null){
		console.error(`getLogs: Error during execution fetchLastBlock, terminated. `);
		return ;
	}
	
	let logsPromises = [];
	
	if(lastBlockNumber == 0){
		unit = process.env.LIMIT_OF_BLOCKS_SYNC;
		await operationControlCheck("increment");
		const client = new MongoClient(mongoUri);
		const db = client.db(dbName);
		const logsDataSet = db.collection(collectionLogs);
		try {
			await client.connect();
			steps = Math.ceil(lastBlock / unit);
			for(i=0;i<=steps;i++){		
				let first_ = i * unit + 1;
				let toBlock = first_ + unit - 1;
				await operationControlCheck("increment");
				logs = await fetchLogs(first_,toBlock,i);
				
				if (logs === null){
					console.error(`getLogs: Error during execution fetchLogs, loop terminated. `);
					return ;
				}
				
				for(j=0;j<logs.length;j++){
					console.log(`Block ${hexToInt(logs[j].blockNumber)} of ${toBlock} | Total: ${lastBlock}`);
					await operationControlCheck("increment");
					logsPromises.push(saveOnSyncMode(logsDataSet, logs[j]));
					await operationControlCheck("check");			
				}
			}
			await Promise.all(logsPromises);
		} catch (error) {
			console.error('Function getLogs Error connecting or operating on MongoDB:', error.message);
			return ;
		} finally {
			await client.close();
		}
	}else if((lastBlock - lastBlockNumber) <= unit && lastBlockNumber < lastBlock){
		await operationControlCheck("increment");	
		logs = await fetchLogs(lastBlockNumber+1,lastBlock,1);
		
		if (logs === null){
			console.error(`getLogs: Error during execution fetchLogs, loop terminated. `);
			return ;
		}
		
		for(j=0;j<logs.length;j++){
			console.log(`Block ${hexToInt(logs[j].blockNumber)} of ${lastBlock} | Total: ${lastBlock}`);
			let saveChainLogsInfo = await saveChainLogs(logs[j]);
			await operationControlCheck("check");
			
			if(!saveChainLogsInfo){
				console.error(`getLogs: Error during execution saveChainLogsInfo, loop terminated. `);
				return ;
			}			
		}			
	}else{
		//Unforeseen hypothesis, solve logic here
		steps = Math.ceil((lastBlock - lastBlockNumber) / unit);
		for(i=0;i<=steps;i++){		
			let first_ = i * unit + lastBlockNumber + 1;
			let toBlock = first_ + unit - 1;
			
			await operationControlCheck("increment");
			console.log(`first_: ${first_} | toBlock: ${toBlock}`);
			logs = await fetchLogs(first_,toBlock,i);
			
			if (logs === null){
				console.error(`getLogs: Error during execution fetchLogs, loop terminated. `);
				return ;
			}
			
			for(j=0;j<logs.length;j++){
				console.log(`Block ${hexToInt(logs[j].blockNumber)} of ${toBlock} | Total: ${lastBlock}`);
				let saveChainLogsInfo = await saveChainLogs(logs[j]);
				await operationControlCheck("check");
				
				if(!saveChainLogsInfo){
					console.error(`getLogs: Error during execution saveChainLogsInfo, loop terminated. `);
					return ;
				}				
			}
		}
	}
	
	console.log(`${updateOperations.updateRecord} Updated, ${updateOperations.newRecord} New Inserteds, ${updateOperations.recordIgnored} Ignored, ${updateOperations.noAction} No Action And ${updateOperations.recordErrors} Errors.`);
	
	await operationControlCheck("increment");
	let saveSystemInfo = await saveSystemData(lastBlock, lastBlockNumber);
	if(saveSystemInfo){
		console.log(`SYSTEM: Updated to height ${lastBlock}, previous block ${lastBlockNumber}`);
	}else{
		console.error(`SYSTEM: Not Updated to height ${lastBlock}, previous block ${lastBlockNumber}, function stoped!`);
	}
	await operationControlCheck("finally");
	return ;
}

// Function to add a delay
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function updateOperatorStatus(dataSet, operator){
	try{
		const result = await dataSet.updateOne(
			{ operatorAddress: operator.operator },
			{
				$set: { 
					nodeStatus: operator.status, 
					nodeRewards: operator.rewards, 
					nodeFee: operator.fee, 
					nodeUptime: operator.uptime,
				},
				$setOnInsert: {
					nodesDelegated: 0,
				}
			},
			{ upsert: true }
		);
		
		if (result.upsertedCount > 0) {
			updateOperations.newRecord++;
			if(DEBUG_MODE)
				console.log(`New operator inserted ${operator.operator}`);
		} else if (result.modifiedCount > 0) {
			updateOperations.updateRecord++;
			if(DEBUG_MODE)
				console.log(`Updated operator ${operator.operator}`);
		} else if(result.matchedCount >= 1 && result.acknowledged) {
			updateOperations.recordIgnored++;
			if(DEBUG_MODE)
				console.log(`Operator ignored ${operator.operator}`);
		} else {
			updateOperations.noAction++;
			if(DEBUG_MODE)
				console.log(`Not Action ${operator.operator}`);
		}
	} catch (error) {
		console.error('Error connecting or operating on MongoDB:', error.message);
	}
	return true;
}

async function updateOperators() {
	await operationControlCheck("init");
    const client = new MongoClient(mongoUri);
	
	updateOperations.newRecord = 0;
	updateOperations.updateRecord = 0;
	updateOperations.recordIgnored = 0;
	updateOperations.noAction = 0;
	updateOperations.recordErrors = 0;

    try {
        await client.connect();
        console.log('Connected to MongoDB');

        const db = client.db(dbName);
        const collection = db.collection(collectionOperators);
		
		let updates = [];

        let idCounter = 0;
		await operationControlCheck("increment");
		OPERATORS = await paginateOperators(1,999);
		
		if (OPERATORS === null){
			console.error(`updateOperators: Error during execution paginateOperators, terminated. `);
			return ;
		}
		
		let total = OPERATORS.length;
		
		console.log(`${OPERATORS.length} Operators known`);

        for (const operator of OPERATORS) {
            // Database query
			await operationControlCheck("increment");
			updates.push(updateOperatorStatus(collection, operator));
            await operationControlCheck("check");
        }
		await Promise.all(updates);
    } catch (error) {
        console.error('Error connecting or operating on MongoDB:', error.message);
    } finally {
		console.log(`${updateOperations.updateRecord} Updated, ${updateOperations.newRecord} New Inserteds, ${updateOperations.recordIgnored} Ignored And ${updateOperations.noAction} No Action.`);
		await client.close();
		await operationControlCheck("finally");
    }
	return ;
}

async function intBlockData(blockDataLog){
	let delegatorsCount = 0;
	for (const log of blockDataLog) {
		if(log.eventType == "DELEGATE"){
			delegatorsCount += log.blockData;
		}else if(log.eventType == "UNDELEGATE"){
			delegatorsCount -= log.blockData;
		}
	}
	return delegatorsCount;
}

async function syncOperatorsTable(operatorsDataSet, operator_, delegator_count){	
	try {
		await operatorsDataSet.updateOne(
			{ operatorAddress: operator_ },
			{
				$set: { nodesDelegated: delegator_count },
				$setOnInsert: {
					nodeStatus: true,
					nodeRewards: "0",
					nodeFee: 1,
					nodeUptime: 100
				}
			},
			{ upsert: true }
		);
	} catch (error) {
		console.error('Function syncOperators Error connecting or operating on MongoDB:', error.message);
	}
	return true;
}

async function getAllOperators() {
	await operationControlCheck("init");
	console.log(`Bringing existing delegate records by operator.`);
    const client = new MongoClient(mongoUri);
	
	updateOperations.newRecord = 0;
	updateOperations.updateRecord = 0;
	updateOperations.recordIgnored = 0;
	updateOperations.noAction = 0;
	updateOperations.recordErrors = 0;
	
	let updates = [];
	let nodes_temp = [];

    try {
        await client.connect();
        console.log('Connected to MongoDB');

        const db = client.db(dbName);
        const operatorsDataSet = db.collection(collectionOperators);
		await operationControlCheck("increment");
		const operators_ = await operatorsDataSet.aggregate([
		{
			$lookup: {
				from: collectionLogs,
				localField: "operatorAddress",
				foreignField: "operator",
				as: "blockData"
			}
		},
		{
        $project: {
			_id: 0,
			operatorAddress: 1,
            nodesDelegated: 1,
            nodeStatus: 1,
            nodeRewards: 1,
            nodeFee: 1,
            nodeUptime: 1,
			"blockData.txHash": 1,
			"blockData.blockTimestamp": 1,
			"blockData.blockData": 1,
			"blockData.eventType": 1,
			"blockData.guardian": 1
			}
		}
		]).toArray();
		
		let idCounter = 0;
		let total = operators_.length;
		let activeNodes = 0;
		let averageUptime = 0;
		let averageFee = 0;
		
		for (let operator of operators_) {
			let delegatorsCount = await intBlockData(operator.blockData);			
			if(delegatorsCount != operator.nodesDelegated){
				await operationControlCheck("increment");
				updates.push(syncOperatorsTable(operatorsDataSet, operator.operatorAddress, delegatorsCount));
				idCounter++;
				updateOperations.updateRecord++;
				operator.nodesDelegated = delegatorsCount;
				if(DEBUG_MODE)
					console.log(`${idCounter}/${total} - Operator updated ${operator.operatorAddress}`);
			}else{
				idCounter++;
				updateOperations.recordIgnored++;
				if(DEBUG_MODE)
					console.log(`${idCounter}/${total} - Operator ignored ${operator.operatorAddress}`);
			}
				
			if (operator.nodeStatus) {
				activeNodes++;
			}
			averageUptime += operator.nodeUptime;
			averageFee += operator.nodeFee;
			nodes_temp.push(operator);			
		}
		
		await Promise.all(updates);

		averageUptime = averageUptime / total;
		averageFee = averageFee / total;
		
		GLOBAL_DELEGATORS = [];
        GLOBAL_DELEGATORS = {
			"nodes": nodes_temp, 
			totals: {
				totalNodes: total,
				activeNodes: activeNodes,
				averageUptime: averageUptime,
				averageFee: averageFee
			},
			lastupdate: Math.floor(Date.now() / 1000)
		};		

        console.log('GLOBAL_DELEGATORS Updated!');		
        
    } catch (error) {
        console.error('Error connecting or operating on MongoDB:', error.message);
        return {};
    } finally {
		await client.close();
		console.log(`${updateOperations.updateRecord} Updated, ${updateOperations.recordIgnored} Ignored And ${updateOperations.noAction} No Action.`);
		await operationControlCheck("finally");
    }
	
	return GLOBAL_DELEGATORS;
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
				if(DEBUG_MODE)
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
				if(DEBUG_MODE)
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

async function launchFunctions(syncLogs = false){
	const client = new MongoClient(mongoUri);
	const db = client.db(dbName);
	const systemDataSet = db.collection(collectionSystem);
	
	try {
		if(!syncLogs){
			await client.connect();
			const existingBlockInfo = await systemDataSet.findOne({});
			if(existingBlockInfo){		
				await updateOperators();
				console.log(`Last existing block information found. ${existingBlockInfo.lastBlockNumber}`);
				await getLogs(existingBlockInfo.lastBlockNumber);
				await getAllOperators();
			}else{
				console.log(`Last existing block information not found. Zero's log sync mode.`);
				await updateOperators();
				await getLogs(0);
				await getAllOperators();
			}	
		}else{
			console.log(`Zero's log sync mode.`);
			await updateOperators();
			await getLogs(0);
			await getAllOperators();
		}
	} catch (error) {
        console.error('Function launchFunctions Error connecting or operating on MongoDB:', error.message);
		return false;
    } finally { 
        await client.close();
		setTimeout(launchFunctions, process.env.REFRESH_INTERVAL * 1000);
		return true;
    }	
}

async function paginateResponse(array, page_size, page_number) {
	const start = (page_number - 1) * page_size;
    const end = start + page_size;

    // Retorna a fatia do array que representa a página
    return array.slice(start, end);
}

// Route to get list of operators
app.get('/operators', async (req, res) => {
    try {
        res.json(GLOBAL_DELEGATORS);
    } catch (error) {
        res.status(500).json({ error: 'Error getting operators...' });
    }
});

// Route to get list of operators by pagination.
app.get('/nodes', async (req, res) => {
	let p_ = 1;
	let l_ = 27;
	if (parseInt(req.query.page) > 0) {
		p_ = parseInt(req.query.page);
	}
	if (parseInt(req.query.limit) > 0) {
		l_ = parseInt(req.query.limit);
	}
	const page = p_;
    const limit = l_;
	const totalPages = Math.ceil(GLOBAL_DELEGATORS.nodes.length / limit);	

	let paginate_result = await paginateResponse(GLOBAL_DELEGATORS.nodes, limit, page);

	response = {
		"nodes": [], 
		totals: GLOBAL_DELEGATORS.totals,
		navInfo: {
			currentPage: p_,
			totalElements: paginate_result.length,
			totalPages: totalPages
		}, 
		lastupdate: GLOBAL_DELEGATORS.lastupdate
	};

	response.nodes = paginate_result;

	res.json(response);
});

// Start the server
app.listen(port, () => {
    console.log(`Server running on http://localhost:${port}`);
});

launchFunctions();