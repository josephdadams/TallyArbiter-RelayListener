/* Tally Arbiter Relay Controller */

//General Variables
const clc = 		require('cli-color');
const io = 			require('socket.io-client');
const fs = 			require('fs');
const path = 		require('path');
const config_file = './config_relays.json'; //local storage JSON file
const USBRelay = 	require('@josephdadams/usbrelay');

//var relay = 		null;
var detectedRelays = [];

var relay_groups = 	[];
var server_config =	[];

var socket = 		null;

var Logs = 			[];

var device_states =	[];
var bus_options =	[];

function startUp() {
	loadConfig();
	setStates();
	openSocket();
}

function loadConfig() {
	try {
		let rawdata = fs.readFileSync(config_file);
		let configJson = JSON.parse(rawdata); 

		if (configJson.relay_groups) {
			relay_groups = configJson.relay_groups;
			logger('Tally Arbiter Relay Groups loaded.', 'info');
		}
		else {
			relay_groups = [];
			logger('Tally Arbiter Relay Groups could not be loaded.', 'error');
		}
		if (configJson.server_config) {
			server_config = configJson.server_config;
			logger('Tally Arbiter Server Config loaded.', 'info');
		}
		else {
			server_config = [];
			logger('Tally Arbiter Server Config could not be loaded.', 'error');
		}
	}
	catch (error) {
		if (error.code === 'ENOENT') {
			logger('The config file could not be found.', 'error');
		}
		else {
			logger('An error occurred while loading the configuration file:', 'error');
			logger(error, 'error');
		}
	}
}

function saveConfig() {
	try {
		let configJson = {
			server_config: server_config,
			relay_groups: relay_groups
		};

		fs.writeFileSync(config_file, JSON.stringify(configJson, null, 1), 'utf8', function(error) {
			if (error)
			{ 
				result.error = 'Error saving configuration to file: ' + error;
			}
		});	
	}
	catch (error) {
		result.error = 'Error saving configuration to file: ' + error;
	}
}

function setStates() {
	try {
		detectedRelays = USBRelay.Relays;
		console.log('Detected Relays:');
		console.log(detectedRelays);
		if (detectedRelays.length > 0) {
			for (let i = 0; i < detectedRelays.length; i++) {
				detectedRelays[i].relay = new USBRelay(detectedRelays[i].path);
			}
		}
		else {
			logger('No USB Relays detected.', 'error');
			process.exit(1);
		}
	}
	catch (error) {
		logger(error, 'error');
	}

	for (let i = 0; i < relay_groups.length; i++) {
		for (let j = 0; j < relay_groups[i].relays.length; j++) {
			relay_groups[i].relays[j].state = false;
		}
	}
}

function logger(log, type) {
	//logs the item to the console, to the log array, and sends the array to the settings page

	let dtNow = new Date();

	switch(type) {
		case 'info':
			console.log(clc.black(`[${dtNow}]`) + '     ' + clc.blue(log));
			break;
		case 'error':
			console.log(clc.black(`[${dtNow}]`) + '     ' + clc.red.bold(log));
			break;
		default:
			console.log(clc.black(`[${dtNow}]`) + '     ' + log);
			break;
	}
	
	let logObj = {};
	logObj.datetime = dtNow;
	logObj.log = log;
	logObj.type = type;
	Logs.push(logObj);
}

function openSocket() {
	//listen for device states emit, bus types, reassign, flash
	//for loop through every relay_group item and make a new socket connection for each

	let ip = server_config.ip;
	let port = server_config.port;

	if (!port) {
		port = 4455;
	}

	if (ip) {
		logger(`Connecting to Tally Arbiter server: ${ip}:${port}`, 'info');
		socket = io.connect('http://' + ip + ':' + port, {reconnect: true});

		socket.on('connect', function(){
			logger('Connected to Tally Arbiter server.', 'info');
		});

		socket.on('disconnect', function(){
			logger('Disconnected from Tally Arbiter server.', 'error');
		});

		socket.on('device_states', function(Device_states) {
			//process the data received and determine if it's in preview or program and adjust the relays accordingly
			device_states = Device_states;
			ProcessTallyData();
		});

		socket.on('listener_relay_assignment', function(relayGroupId, deviceId) {
			for (let i = 0; i < relay_groups.length; i++) {
				if (relay_groups[i].id === relayGroupId) {
					relay_groups[i].deviceId = deviceId;
					logger(`Relay Group ${relayGroupId} assigned to Device ${deviceId}`, 'info');
					saveConfig();
					break;
				}
			}
		});

		socket.on('bus_options', function(Bus_options) {
			bus_options = Bus_options;
		});

		socket.on('flash', function(relayGroupId) {
			//flash the specific relay group
			FlashRelayGroup(relayGroupId);
			logger(`Flash received for Relay Group: ${relayGroupId}`);
		});

		socket.on('reassign', function(relayGroupId, oldDeviceId, newDeviceId) {
			//reassign the relay to a new device
			for (let i = 0; i < relay_groups.length; i++) {
				if (relay_groups[i].id === relayGroupId) {
					relay_groups[i].deviceId = newDeviceId;
					logger(`Relay Group ${relayGroupId} reassigned to Device ${newDeviceId}`, 'info');
					saveConfig();
				}
			}
			socket.emit('listener_reassign_relay', relayGroupId, oldDeviceId, newDeviceId);
		});

		socket.emit('bus_options');

		for(let i = 0; i < relay_groups.length; i++) {
			socket.emit('device_listen_relay', relay_groups[i].id, relay_groups[i].deviceId);
		}
	}
}

function getBusTypeById(busId) {
	//gets the bus type (preview/program) by the bus id
	let bus = bus_options.find( ({ id }) => id === busId);

	return bus.type;
}

function ProcessTallyData() {
	for (let i = 0; i < device_states.length; i++) {
		if (getBusTypeById(device_states[i].busId) === 'preview') {
			if (device_states[i].sources.length > 0) {
				UpdateRelay(device_states[i].deviceId, 'preview', true);
			}
			else {
				UpdateRelay(device_states[i].deviceId, 'preview', false);
			}
		}
		else if (getBusTypeById(device_states[i].busId) === 'program') {
			if (device_states[i].sources.length > 0) {
				UpdateRelay(device_states[i].deviceId, 'program', true);
			}
			else {
				UpdateRelay(device_states[i].deviceId, 'program', false);
			}
		}
	}
}

function UpdateRelay(deviceId, bus, value) {
	for (let i = 0; i < relay_groups.length; i++) {
		if (relay_groups[i].deviceId === deviceId) {
			for (let j = 0; j < relay_groups[i].relays.length; j++) {
				if (relay_groups[i].relays[j].busType === bus) {
					relaySetState(relay_groups[i].relays[j].relaySerial, relay_groups[i].relays[j].relayNumber, value);
					relay_groups[i].relays[j].state = value;
				}
			}
		}
	}
}

function FlashRelayGroup(relayGroupId) {
	if (relay != null) {
		for (let i = 0; i < relay_groups.length; i++) {
			if (relay_groups[i].id === relayGroupId) {
				for (let j = 0; j < relay_groups[i].relays.length; j++) {
					relaySetState(relay_groups[i].relays[j].relaySerial, relay_groups[i].relays[j].relayNumber, true);
					setTimeout(function () {
						relaySetState(relay_groups[i].relays[j].relaySerial, relay_groups[i].relays[j].relayNumber, false);
						setTimeout(function () {
							relaySetState(relay_groups[i].relays[j].relaySerial, relay_groups[i].relays[j].relayNumber, true);
							setTimeout(function () {
								relaySetState(relay_groups[i].relays[j].relaySerial, relay_groups[i].relays[j].relayNumber, false);
								setTimeout(function () {
									relaySetState(relay_groups[i].relays[j].relaySerial, relay_groups[i].relays[j].relayNumber, relay_groups[i].relays[j].state);
								}, 500);
							}, 500)
						}, 500);
					}, 500);
				}
				break;
			}
		}
	}
	else {
		logger('Error flashing USB relay group: No USB relays have been initialized. Are you sure it is connected?', 'error');
	}
}

function relaySetState(relaySerial, relayNumber, state) {
	//sets the state of a relay
	if (relaySerial !== null) {
		//loop through array of relays and determine which one to set
		for (let i = 0; i < detectedRelays.length; i++) {
			if (detectedRelays[i].serial === relaySerial) {
				//set the relay state
				console.log('setting relay state: ' + relaySerial + ': ' + relayNumber + ' to ' + state);
				detectedRelays[i].relay.setState(relayNumber, state);
				break;
			}
		}
	}
	else {
		if (detectedRelays.length > 0) {
			logger('Error setting relay state: No USB relays have been initialized. Are you sure it is connected?', 'error');
		}
	}
}

startUp();