"use strict";

const path = require("path");
const fs = require('fs');
const axios = require("axios");
const crypto = require("crypto");
const express = require("express");
const { debug } = require("console");
const { get } = require("http");

const rrLocalConnector = require("./lib/localConnector").localConnector;
const roborock_mqtt_connector = require("./lib/roborock_mqtt_connector").roborock_mqtt_connector;
const rrMessage = require("./lib/message").message;
const vacuum_class = require("./lib/vacuum").vacuum;
const roborockPackageHelper = require("./lib/roborockPackageHelper").roborockPackageHelper;
const deviceFeatures = require("./lib/deviceFeatures").deviceFeatures;
const messageQueueHandler = require("./lib/messageQueueHandler").messageQueueHandler;


let socketServer, webserver;

const dockingStationStates = ["cleanFluidStatus", "waterBoxFilterStatus", "dustBagStatus", "dirtyWaterBoxStatus", "clearWaterBoxStatus", "isUpdownWaterReady"];

function md5hex(str) {
	return crypto.createHash("md5").update(str).digest("hex");
}

class Roborock {

	constructor(options) {

		this.bInited = false;

		this.config = options;

		this.updateInterval = options.updateInterval || 180;
		this.log = options.log || console;
		this.language = options.language || "en";
		
		this.localKeys = null;
		this.roomIDs = {};
		this.vacuums = {};
		this.socket = null;

		this.objects = {};
		this.states = {};

		this.idCounter = 0;
		this.nonce = crypto.randomBytes(16);
		this.messageQueue = new Map();

		this.roborockPackageHelper = new roborockPackageHelper(this);

		this.localConnector = new rrLocalConnector(this);
		this.rr_mqtt_connector = new roborock_mqtt_connector(this);
		this.message = new rrMessage(this);

		this.messageQueueHandler = new messageQueueHandler(this);

		this.pendingRequests = new Map();

		this.localDevices = {};
		this.remoteDevices = new Set();

		this.scenesData = null; // Store scenes data locally

		this.name = "roborock";
		this.deviceNotify = null;
		this.baseURL = options.baseURL || "usiot.roborock.com";
	}

	isInited() {
		return this.bInited;
	}

	setInterval(callback, interval, ...args) {
		return setInterval(() => callback(...args), interval);
	}

	clearInterval(interval) {
		clearInterval(interval);
	}

	setTimeout(callback, timeout, ...args) {
		return setTimeout(() => callback(...args), timeout);
	}

	clearTimeout(timeout) {
		clearTimeout(timeout);
	}
	
	//dummy function for calling setObjectNotExistsAsync
	async setObjectNotExistsAsync(id, obj) {

	}

	//dummy function for calling setObjectAsync
	async setObjectAsync(id, obj) {

	}

	//dummy function for calling getObjectAsync
	async getObjectAsync(id) {

	}

	//dummy function for calling delObjectAsync
	async delObjectAsync(id) {

	}

	getStateAsync(id) {

		try {
			if(id == "UserData" || id == "clientID"){
				return JSON.parse(fs.readFileSync(path.resolve(__dirname, `./data/${id}`), 'utf8'));
			}

			return this.states[id];
			
		}catch(error) {
			this.log.error(`getStateAsync: ${error}`);
		}

		return null;
	}

	async setStateAsync(id, state) {
		try {

			if(id == "UserData" || id == "clientID"){
				fs.writeFileSync(path.resolve(__dirname, `./data/${id}`), JSON.stringify(state, null, 2, 'utf8'));
			}

			this.states[id] = state;

			if(this.deviceNotify && (id == "HomeData" || id == "CloudMessage")){
				this.deviceNotify(id, state);
			}
			
		}catch(error) {
			this.log.error(`setStateAsync: ${error}`);
		}
	}

	async setStateChangedAsync(id, state) {
		await this.setStateAsync(id, state);
	}

	async deleteStateAsync(id) {
		try {

			if(id == "UserData" || id == "clientID"){
				fs.unlinkSync(path.resolve(__dirname, `./data/${id}`));
			}

			delete this.states[id];

			
		}catch(error) {
			this.log.error(`deleteStateAsync: ${error}`);
		}
	}
	
	subscribeStates(id) {
		this.log.debug(`subscribeStates: ${id}`);
	}	

	/**
	 * Is called when databases are connected and adapter received configuration.
	 */
	async startService(callback) {


		this.log.info(`Starting adapter. This might take a few minutes depending on your setup. Please wait.`);
		this.translations = require(`./i18n/${this.language || "en"}/translations.json`);


		// create new clientID if it doesn't exist yet
		let clientID = "";
		try {
			const storedClientID = await this.getStateAsync("clientID");
			if (storedClientID) {
				clientID = storedClientID.val?.toString() ?? "";
			} else {
				clientID = crypto.randomUUID();
				await this.setStateAsync("clientID", { val: clientID, ack: true });
			}
		} catch (error) {
			this.log.error(`Error while retrieving or setting clientID: ${error.message}`);
		}

		if (!this.config.username || !this.config.password) {
			this.log.error("Username or password missing!");
			return;
		}

		this.instance = clientID;
		
		// Initialize the login API (which is needed to get access to the real API).
		this.loginApi = axios.create({
			baseURL: 'https://' + this.baseURL,
			headers: {
				header_clientid: crypto.createHash("md5").update(this.config.username).update(clientID).digest().toString("base64"),
			},
		});
		await this.setStateAsync("info.connection", { val: true, ack: true });
		// api/v1/getUrlByEmail(email = ...)

		const userdata = await this.getUserData(this.loginApi);

		try {
			this.loginApi.defaults.headers.common["Authorization"] = userdata.token;
		} catch (error) {
			this.log.error("Failed to login. Most likely wrong token! Deleting HomeData and UserData. Try again! " + error);

			this.deleteStateAsync("HomeData");
			this.deleteStateAsync("UserData");
		}
		const rriot = userdata.rriot;

		// Initialize the real API.
		this.api = axios.create({
			baseURL: rriot.r.a,
		});
		this.api.interceptors.request.use((config) => {
			try {
				const timestamp = Math.floor(Date.now() / 1000);
				const nonce = crypto.randomBytes(6).toString("base64").substring(0, 6).replace("+", "X").replace("/", "Y");
				let url;
				if (this.api) {
					url = new URL(this.api.getUri(config));
					const prestr = [rriot.u, rriot.s, nonce, timestamp, md5hex(url.pathname), /*queryparams*/ "", /*body*/ ""].join(":");
					const mac = crypto.createHmac("sha256", rriot.h).update(prestr).digest("base64");

					config.headers["Authorization"] = `Hawk id="${rriot.u}", s="${rriot.s}", ts="${timestamp}", nonce="${nonce}", mac="${mac}"`;
				}
			} catch (error) {
				this.log.error("Failed to initialize API. Error: " + error);
			}
			return config;
		});

		// Get home details.
		try {
			const homeDetail = await this.loginApi.get("api/v1/getHomeDetail");
			if (homeDetail) {
				const homeId = homeDetail.data.data.rrHomeId;

				if (this.api) {
					const homedata = await this.api.get(`v2/user/homes/${homeId}`);
					const homedataResult = homedata.data.result;

					const scene = await this.api.get(`user/scene/home/${homeId}`);

					await this.setStateAsync("HomeData", {
						val: JSON.stringify(homedataResult),
						ack: true,
					});

					// skip devices that sn in ingoredDevices
					const ignoredDevices = this.config.ignoredDevices || [];
					// create devices and set states
					this.products = homedataResult.products;
					this.devices = homedataResult.devices;
					this.devices = this.devices.filter((device) => !ignoredDevices.includes(device.sn));
					this.localKeys = new Map(this.devices.map((device) => [device.duid, device.localKey]));

					// this.adapter.log.debug(`initUser test: ${JSON.stringify(Array.from(this.adapter.localKeys.entries()))}`);

					await this.rr_mqtt_connector.initUser(userdata);
					await this.rr_mqtt_connector.initMQTT_Subscribe();
					await this.rr_mqtt_connector.initMQTT_Message();

					// store name of each room via ID
					const rooms = homedataResult.rooms;
					for (const room in rooms) {
						const roomID = rooms[room].id;
						const roomName = rooms[room].name;

						this.roomIDs[roomID] = roomName;
					}
					this.log.debug(`RoomIDs debug: ${JSON.stringify(this.roomIDs)}`);

					// reconnect every 3 hours (10800 seconds)
					this.reconnectIntervall = this.setInterval(async () => {
						this.log.debug(`Reconnecting after 3 hours!`);

						await this.rr_mqtt_connector.reconnectClient();
					}, 3600 * 1000);

					this.processScene(scene);

					this.homedataInterval = this.setInterval(this.updateHomeData.bind(this), this.updateInterval * 1000, homeId);
					await this.updateHomeData(homeId);

					const discoveredDevices = await this.localConnector.getLocalDevices();

					await this.createDevices();
					await this.getNetworkInfo();

					// merge udp discovered devices with local devices found via mqtt
					Object.entries(discoveredDevices).forEach(([duid, ip]) => {

						if (!Object.prototype.hasOwnProperty.call(this.localDevices, duid)) {
							this.localDevices[duid] = ip;
						}

						
					});
					this.log.debug(`localDevices: ${JSON.stringify(this.localDevices)}`);

					for (const device in this.localDevices) {
						const duid = device;
						const ip = this.localDevices[device];

						await this.localConnector.createClient(duid, ip);
					}
					
					await this.initializeDeviceUpdates();
					this.bInited = true;
					this.log.info(`Starting adapter finished. Lets go!!!!!!!`);

				} else {
					this.log.info(`Most likely failed to login. Deleting UserData to force new login!`);
					await this.deleteStateAsync(`UserData`);

					
				}				
			}
		} catch (error) {
			this.log.error("Failed to get home details: " + error.stack);
		}

		if(callback){
			callback();
		}

	}


	async stopService() {
	
		try {
			await this.clearTimersAndIntervals();
			this.bInited = false;
		} catch (e) {
			this.catchError(e.stack);
		}

	}

	async getUserData(loginApi) {
		try {
			const response = await loginApi.post(
				"api/v1/login",
				new URLSearchParams({
					username: this.config.username,
					password: this.config.password,
					needtwostepauth: "false",
				}).toString()
			);
			const userdata = response.data.data;

			if (!userdata) {
				throw new Error("Login returned empty userdata.");
			}

			await this.setStateAsync("UserData", {
				val: JSON.stringify(userdata),
				ack: true,
			});

			return userdata;
		} catch (error) {
			this.log.error(`Error in getUserData: ${error.message}`);
			await this.deleteStateAsync("HomeData");
			await this.deleteStateAsync("UserData");
			throw error;
		}
	}

	async getNetworkInfo() {
		const devices = this.devices;
		for (const device in devices) {
			const duid = devices[device].duid;
			const vacuum = this.vacuums[duid];
			await vacuum.getParameter(duid, "get_network_info");
		}
	}

	async createDevices() {
		const devices = this.devices;

		for (const device of devices) {
			const duid = device.duid;
			const name = device.name;

			this.log.debug(`Creating device: ${name} with duid: ${duid}`);

			const robotModel = this.getProductAttribute(duid, "model");

			//model nust starts with "roborock.vacuum."
			if (!robotModel.startsWith("roborock.vacuum.")) {
				this.log.error(`Unknown model: ${robotModel}`);
				continue;
			}


			this.vacuums[duid] = new vacuum_class(this, robotModel);
			this.vacuums[duid].name = name;
			this.vacuums[duid].features = new deviceFeatures(this, device.featureSet, device.newFeatureSet, duid);

			await this.vacuums[duid].features.processSupportedFeatures();

			await this.vacuums[duid].setUpObjects(duid);

			// sub to all commands of this robot
			this.subscribeStates("Devices." + duid + ".commands.*");
			this.subscribeStates("Devices." + duid + ".reset_consumables.*");
			this.subscribeStates("Devices." + duid + ".programs.startProgram");
			this.subscribeStates("Devices." + duid + ".deviceInfo.online");
		}
	}

	async initializeDeviceUpdates() {
		this.log.debug(`initializeDeviceUpdates`);

		const devices = this.devices;

		for (const device of devices) {
			const duid = device.duid;
			const robotModel = this.getProductAttribute(duid);

			this.vacuums[duid].mainUpdateInterval = () =>
				this.setInterval(this.updateDataMinimumData.bind(this), this.updateInterval * 1000, duid, this.vacuums[duid], robotModel);

			if (device.online) {
				this.log.debug(`${duid} online. Starting mainUpdateInterval.`);
				this.vacuums[duid].mainUpdateInterval(); // actually start mainUpdateInterval()
			}

			this.vacuums[duid].getStatusIntervall = () => this.setInterval(this.getStatus.bind(this), 1000, duid, this.vacuums[duid], robotModel);

			if (device.online) {
				this.log.debug(`${duid} online. Starting getStatusIntervall.`);
				this.vacuums[duid].getStatusIntervall(); // actually start getStatusIntervall()
			}

			await this.updateDataExtraData(duid, this.vacuums[duid]);
			await this.updateDataMinimumData(duid, this.vacuums[duid], robotModel);

			await this.vacuums[duid].getCleanSummary(duid);

		}
	}


	async processScene(scene) {
		if (scene && scene.data.result) {
			this.log.debug(`Processing scene ${JSON.stringify(scene.data.result)}`);

			const programs = {};
			for (const program in scene.data.result) {
				const enabled = scene.data.result[program].enabled;
				const programID = scene.data.result[program].id;
				const programName = scene.data.result[program].name;
				const param = scene.data.result[program].param;

				this.log.debug(`Processing scene param ${param}`);
				const duid = JSON.parse(param).action.items[0].entityId;

				if (!programs[duid]) {
					programs[duid] = {};
				}
				programs[duid][programID] = programName;

				await this.setObjectNotExistsAsync(`Devices.${duid}.programs`, {
					type: "folder",
					common: {
						name: "Programs",
					},
					native: {},
				});

				await this.setObjectAsync(`Devices.${duid}.programs.${programID}`, {
					type: "folder",
					common: {
						name: programName,
					},
					native: {},
				});

				const enabledPath = `Devices.${duid}.programs.${programID}.enabled`;
				await this.createStateObjectHelper(enabledPath, "enabled", "boolean", null, null, "value");
				this.setStateAsync(enabledPath, enabled, true);

				const items = JSON.parse(param).action.items;
				for (const item in items) {
					for (const attribute in items[item]) {
						const objectPath = `Devices.${duid}.programs.${programID}.items.${item}.${attribute}`;
						let value = items[item][attribute];
						const typeOfValue = typeof value;

						await this.createStateObjectHelper(objectPath, attribute, typeOfValue, null, null, "value", true, false);

						if (typeOfValue == "object") {
							value = value.toString();
						}
						this.setStateAsync(objectPath, value, true);
					}
				}
			}

			for (const duid in programs) {
				const objectPath = `Devices.${duid}.programs.startProgram`;
				await this.createStateObjectHelper(objectPath, "Start saved program", "string", null, Object.keys(programs[duid])[0], "value", true, true, programs[duid]);
			}
		}
	}

	async executeScene(sceneID) {
		if (this.api) {
			try {
				await this.api.post(`user/scene/${sceneID.val}/execute`);
			} catch (error) {
				this.catchError(error.stack, "executeScene");
			}
		}
	}

	/**
	 * Get the home ID from the login API
	 * @returns {Promise<string>} The home ID
	 */
	async getHomeID() {
		if (!this.loginApi) {
			throw new Error("loginApi is not initialized. Call init() first.");
		}

		try {
			const homeDetail = await this.loginApi.get("api/v1/getHomeDetail");
			if (homeDetail && homeDetail.data && homeDetail.data.data) {
				return homeDetail.data.data.rrHomeId;
			}
			throw new Error("Failed to get home ID from homeDetail response");
		} catch (error) {
			this.log.error(`Failed to get home ID: ${error.message}`);
			throw error;
		}
	}

	/**
	 * Get scenes from the Roborock API
	 * @returns {Promise<Object>} The scenes data
	 */
	async getScenes() {
		if (!this.loginApi) {
			throw new Error("loginApi is not initialized. Call init() first.");
		}
		if (!this.api) {
			throw new Error("api is not initialized. Call initializeRealApi() first");
		}

		try {
			const homeId = await this.getHomeID();
			const response = await this.api.get(`user/scene/home/${homeId}`);
			
			// Store scenes data locally
			this.scenesData = response.data;
			
			return response.data;
		} catch (error) {
			this.log.error(`Failed to get scenes: ${error.message}`);
			throw error;
		}
	}

	/**
	 * Get scenes for a specific device by duid
	 * @param {string} duid - The device unique identifier
	 * @returns {Array} Array of scenes for the specified device
	 */
	getScenesForDevice(duid) {
		// If duid provided, filter scenes for that device
		if (!this.scenesData || !this.scenesData.result) {
			this.log.warn(`No scenes data available. Call getScenes() first.`);
			return [];
		}

		try {
			const deviceScenes = [];
			
			for (const scene of this.scenesData.result) {
				if (scene.param) {
					try {
						const param = JSON.parse(scene.param);
						if (param.action && param.action.items) {
							// Check if any item in the scene has the matching entityId (duid)
							const hasMatchingDevice = param.action.items.some(item => 
								item.entityId === duid
							);
							
							if (hasMatchingDevice) {
								deviceScenes.push({
									id: scene.id,
									name: scene.name,
									enabled: scene.enabled,
									type: scene.type,
									param: scene.param
								});
							}
						}
					} catch (parseError) {
						this.log.warn(`Failed to parse scene param for scene ${scene.id}: ${parseError.message}`);
					}
				}
			}

			this.log.debug(`Found ${deviceScenes.length} scenes for device ${duid}`);
			return deviceScenes;
		} catch (error) {
			this.log.error(`Failed to filter scenes for device ${duid}: ${error.message}`);
			return [];
		}
	}

	getProductAttribute(duid, attribute) {
		const products = this.products;
		const productID = this.devices.find((device) => device.duid == duid).productId;
		const product = products.find((product) => product.id == productID);

		return product ? product[attribute] : null;
	}

	startMainUpdateInterval(duid, online) {
		const robotModel = this.getProductAttribute(duid, "model");

		this.vacuums[duid].mainUpdateInterval = () =>
			this.setInterval(this.updateDataMinimumData.bind(this), this.updateInterval * 1000, duid, this.vacuums[duid], robotModel);
		if (online) {
			this.log.debug(`${duid} online. Starting mainUpdateInterval.`);
			this.vacuums[duid].mainUpdateInterval(); // actually start mainUpdateInterval()
			// Map updater gets startet automatically via getParameter with get_status
		}
	}

	decodeSniffedMessage(data, devices) {
		const dataString = JSON.stringify(data);

		const duidMatch = dataString.match(/\/(\w+)\.\w{3}'/);
		if (duidMatch) {
			const duidSniffed = duidMatch[1];

			const device = devices.find((device) => device.duid === duidSniffed);
			if (device) {
				const localKey = device.localKey;

				const payloadMatch = dataString.match(/'([a-fA-F0-9]+)'/);
				if (payloadMatch) {
					const hexPayload = payloadMatch[1];
					const msg = Buffer.from(hexPayload, "hex");

					const decodedMessage = this.message._decodeMsg(msg, localKey);
					this.log.debug(`Decoded sniffing message: ${JSON.stringify(JSON.parse(decodedMessage.payload))}`);
				}
			}
		}
	}

	async onlineChecker(duid) {
		
		const homedata = await this.getStateAsync("HomeData");

		// If the home data is not found or if its value is not a string, return false.
		if (homedata && typeof homedata.val == "string") {
			const homedataJSON = JSON.parse(homedata.val);
			const device = homedataJSON.devices.find((device) => device.duid == duid);
			const receivedDevice = homedataJSON.receivedDevices.find((device) => device.duid == duid);

			// If the device is not found, return false.
			if (!device && !receivedDevice) {
				return false;
			}

			return device?.online || receivedDevice?.online;
		} else {
			return false;
		}
	}

	async isRemoteDevice(duid) {
		const homedata = await this.getStateAsync("HomeData");

		if (homedata && typeof homedata.val == "string") {
			const homedataJSON = JSON.parse(homedata.val);
			const receivedDevice = homedataJSON.receivedDevices.find((device) => device.duid == duid);
			const remoteDevice = this.remoteDevices.has(duid);

			if (receivedDevice || remoteDevice) {
				return true;
			}

			return false;
		} else {
			return false;
		}
	}

	async getConnector(duid) {
		const isRemote = await this.isRemoteDevice(duid);

		if (isRemote) {
			return this.rr_mqtt_connector;
		} else {
			return this.localConnector;
		}
	}

	async manageDeviceIntervals(duid) {
		return this.onlineChecker(duid)
			.then((onlineState) => {
				if (!onlineState && this.vacuums[duid].mainUpdateInterval) {
					this.clearInterval(this.vacuums[duid].getStatusIntervall);
					this.clearInterval(this.vacuums[duid].mainUpdateInterval);
				} else if (!this.vacuums[duid].mainUpdateInterval) {
					this.vacuums[duid].getStatusIntervall();
					this.startMainUpdateInterval(duid, onlineState);
				}
				return onlineState;
			})
			.catch((error) => {
				this.log.error("startStopIntervals " + error);

				return false; // Make device appear as offline on error. Just in case.
			});
	}

	async updateDataMinimumData(duid, vacuum, robotModel) {
		this.log.debug(`Latest data requested`);

		if (robotModel == "roborock.wm.a102") {
			// nothing for now
		} else if (robotModel == "roborock.wetdryvac.a56") {
			// nothing for now
		} else {
			await vacuum.getParameter(duid, "get_room_mapping");

			await vacuum.getParameter(duid, "get_consumable");

			await vacuum.getParameter(duid, "get_server_timer");

			await vacuum.getParameter(duid, "get_timer");

			await this.checkForNewFirmware(duid);

			switch (robotModel) {
				case "roborock.vacuum.s4":
				case "roborock.vacuum.s5":
				case "roborock.vacuum.s5e":
				case "roborock.vacuum.a08":
				case "roborock.vacuum.a10":
				case "roborock.vacuum.a40":
				case "roborock.vacuum.a140":
				case "roborock.vacuum.ss07":
					//do nothing
					break;
				case "roborock.vacuum.s6":
					await vacuum.getParameter(duid, "get_carpet_mode");
					break;
				case "roborock.vacuum.a27":
					await vacuum.getParameter(duid, "get_dust_collection_switch_status");
					await vacuum.getParameter(duid, "get_wash_towel_mode");
					await vacuum.getParameter(duid, "get_smart_wash_params");
					await vacuum.getParameter(duid, "app_get_dryer_setting");
					break;
				default:
					await vacuum.getParameter(duid, "get_carpet_mode");
					await vacuum.getParameter(duid, "get_carpet_clean_mode");
					await vacuum.getParameter(duid, "get_water_box_custom_mode");
			}
		}
	}

	async updateDataExtraData(duid, vacuum) {
		await vacuum.getParameter(duid, "get_fw_features");

		await vacuum.getParameter(duid, "get_multi_maps_list");
		
	}

	clearTimersAndIntervals() {
		if (this.reconnectIntervall) {
			this.clearInterval(this.reconnectIntervall);
		}
		if (this.homedataInterval) {
			this.clearInterval(this.homedataInterval);
		}
		if (this.commandTimeout) {
			this.clearTimeout(this.commandTimeout);
		}

		this.localConnector.clearLocalDevicedTimeout();

		for (const duid in this.vacuums) {
			this.clearInterval(this.vacuums[duid].getStatusIntervall);
			this.clearInterval(this.vacuums[duid].mainUpdateInterval);
		}

		this.messageQueue.forEach(({ timeout102, timeout301 }) => {
			this.clearTimeout(timeout102);
			if (timeout301) {
				this.clearTimeout(timeout301);
			}
		});

		// Clear the messageQueue map
		this.messageQueue.clear();

		if (this.webSocketInterval) {
			this.clearInterval(this.webSocketInterval);
		}
	}

	checkAndClearRequest(requestId) {
		const request = this.messageQueue.get(requestId);
		if (!request?.timeout102 && !request?.timeout301) {
			this.messageQueue.delete(requestId);
			// this.log.debug(`Cleared messageQueue`);
		} else {
			this.log.debug(`Not clearing messageQueue. ${request.timeout102}  - ${request.timeout301}`);
		}
		this.log.debug(`Length of message queue: ${this.messageQueue.size}`);
	}

	async updateHomeData(homeId) {
		this.log.debug(`Updating HomeData with homeId: ${homeId}`);
		if (this.api) {
			try {
				const home = await this.api.get(`user/homes/${homeId}`);
				const homedata = home.data.result;

				if (homedata) {
					await this.setStateAsync("HomeData", {
						val: JSON.stringify(homedata),
						ack: true,
					});
					this.log.debug(`homedata successfully updated`);

					await this.updateConsumablesPercent(homedata.devices);
					await this.updateConsumablesPercent(homedata.receivedDevices);
					await this.updateDeviceInfo(homedata.devices);
					await this.updateDeviceInfo(homedata.receivedDevices);
					await this.getScenes();
				} else {
					this.log.warn("homedata failed to download");
				}
			} catch (error) {
				this.log.error(`Failed to update updateHomeData with error: ${error}`);
			}
		}
	}

	async updateConsumablesPercent(devices) {
		for (const device of devices) {
			const duid = device.duid;
			const deviceStatus = device.deviceStatus;

			for (const [attribute, value] of Object.entries(deviceStatus)) {
				const targetConsumable = await this.getObjectAsync(`Devices.${duid}.consumables.${attribute}`);

				if (targetConsumable) {
					const val = value >= 0 && value <= 100 ? parseInt(value) : 0;
					await this.setStateAsync(`Devices.${duid}.consumables.${attribute}`, { val: val, ack: true });
				}
			}
		}
	}

	async updateDeviceInfo(devices) {
		for (const device in devices) {
			const duid = devices[device].duid;

			for (const deviceAttribute in devices[device]) {
				if (typeof devices[device][deviceAttribute] != "object") {
					let unit;
					if (deviceAttribute == "activeTime") {
						unit = "h";
						devices[device][deviceAttribute] = Math.round(devices[device][deviceAttribute] / 1000 / 60 / 60);
					}
					await this.setObjectAsync("Devices." + duid + ".deviceInfo." + deviceAttribute, {
						type: "state",
						common: {
							name: deviceAttribute,
							type: this.getType(devices[device][deviceAttribute]),
							unit: unit,
							role: "value",
							read: true,
							write: false,
						},
						native: {},
					});
					this.setStateChangedAsync("Devices." + duid + ".deviceInfo." + deviceAttribute, { val: devices[device][deviceAttribute], ack: true });
				}
			}
		}
	}

	async checkForNewFirmware(duid) {
		const isLocalDevice = !this.isRemoteDevice(duid);

		if (isLocalDevice) {
			this.log.debug(`getting firmware status`);
			if (this.api) {
				try {
					const update = await this.api.get(`ota/firmware/${duid}/updatev2`);

					await this.setObjectNotExistsAsync("Devices." + duid + ".updateStatus", {
						type: "folder",
						common: {
							name: "Update status",
						},
						native: {},
					});

					for (const state in update.data.result) {
						await this.setObjectNotExistsAsync("Devices." + duid + ".updateStatus." + state, {
							type: "state",
							common: {
								name: state,
								type: this.getType(update.data.result[state]),
								role: "value",
								read: true,
								write: false,
							},
							native: {},
						});
						this.setStateAsync("Devices." + duid + ".updateStatus." + state, {
							val: update.data.result[state],
							ack: true,
						});
					}
				} catch (error) {
					this.catchError(error, "checkForNewFirmware()", duid);
				}
			}
		}
	}

	getType(attribute) {
		// Get the type of the attribute.
		const type = typeof attribute;

		// Return the appropriate string representation of the type.
		switch (type) {
			case "boolean":
				return "boolean";
			case "number":
				return "number";
			default:
				return "string";
		}
	}

	async createStateObjectHelper(path, name, type, unit, def, role, read, write, states, native = {}) {
		const common = {
			name: name,
			type: type,
			unit: unit,
			role: role,
			read: read,
			write: write,
			states: states,
		};

		if (def !== undefined && def !== null && def !== "") {
			common.def = def;
		}

		this.setObjectAsync(path, {
			type: "state",
			common: common,
			native: native,
		});
	}

	async createCommand(duid, command, type, defaultState, states) {
		const path = `Devices.${duid}.commands.${command}`;
		const name = this.translations[command];

		const common = {
			name: name,
			type: type,
			role: "value",
			read: true,
			write: true,
			def: defaultState,
			states: states,
		};

		this.setObjectAsync(path, {
			type: "state",
			common: common,
			native: {},
		});
	}

	async createDeviceStatus(duid, state, type, states, unit) {
		const path = `Devices.${duid}.deviceStatus.${state}`;
		const name = this.translations[state];

		const common = {
			name: name,
			type: type,
			role: "value",
			unit: unit,
			read: true,
			write: false,
			states: states,
		};

		this.setObjectAsync(path, {
			type: "state",
			common: common,
			native: {},
		});
	}

	async createDockingStationObject(duid) {
		for (const state of dockingStationStates) {
			const path = `Devices.${duid}.dockingStationStatus.${state}`;
			const name = this.translations[state];

			this.setObjectNotExistsAsync(path, {
				type: "state",
				common: {
					name: name,
					type: "number",
					role: "value",
					read: true,
					write: false,
					states: { 0: "UNKNOWN", 1: "ERROR", 2: "OK" },
				},
				native: {},
			});
		}
	}

	async createConsumable(duid, state, type, states, unit) {
		const path = `Devices.${duid}.consumables.${state}`;
		const name = this.translations[state];

		const common = {
			name: name,
			type: type,
			role: "value",
			unit: unit,
			read: true,
			write: false,
			states: states,
		};

		this.setObjectAsync(path, {
			type: "state",
			common: common,
			native: {},
		});
	}

	async createResetConsumables(duid, state) {
		const path = `Devices.${duid}.resetConsumables.${state}`;
		const name = this.translations[state];

		this.setObjectNotExistsAsync(path, {
			type: "state",
			common: {
				name: name,
				type: "boolean",
				role: "value",
				read: true,
				write: true,
				def: false,
			},
			native: {},
		});
	}

	async createCleaningRecord(duid, state, type, states, unit) {
		let start = 0;
		let end = 19;
		const robotModel = this.getProductAttribute(duid, "model");
		if (robotModel == "roborock.vacuum.a97") {
			start = 1;
			end = 20;
		}

		for (let i = start; i <= end; i++) {
			await this.setObjectAsync(`Devices.${duid}.cleaningInfo.records.${i}`, {
				type: "folder",
				common: {
					name: `Cleaning record ${i}`,
				},
				native: {},
			});

			this.setObjectAsync(`Devices.${duid}.cleaningInfo.records.${i}.${state}`, {
				type: "state",
				common: {
					name: this.translations[state],
					type: type,
					role: "value",
					unit: unit,
					read: true,
					write: false,
					states: states,
				},
				native: {},
			});

			await this.setObjectAsync(`Devices.${duid}.cleaningInfo.records.${i}.map`, {
				type: "folder",
				common: {
					name: "Map",
				},
				native: {},
			});
			for (const name of ["mapBase64", "mapBase64Truncated", "mapData"]) {
				const objectString = `Devices.${duid}.cleaningInfo.records.${i}.map.${name}`;
				await this.createStateObjectHelper(objectString, name, "string", null, null, "value", true, false);
			}
		}
	}

	async createCleaningInfo(duid, key, object) {
		const path = `Devices.${duid}.cleaningInfo.${key}`;
		const name = this.translations[object.name];

		this.setObjectAsync(path, {
			type: "state",
			common: {
				name: name,
				type: "number",
				role: "value",
				unit: object.unit,
				read: true,
				write: false,
			},
			native: {},
		});
	}

	async createBaseRobotObjects(duid) {
		for (const name of ["mapBase64", "mapBase64Truncated", "mapData"]) {
			const objectString = `Devices.${duid}.map.${name}`;
			await this.createStateObjectHelper(objectString, name, "string", null, null, "value", true, false);
		}

		this.createNetworkInfoObjects(duid);
	}

	async createBasicVacuumObjects(duid) {
		this.createNetworkInfoObjects(duid);
	}

	async createBasicWashingMachineObjects(duid) {
		this.createNetworkInfoObjects(duid);
	}

	async createNetworkInfoObjects(duid) {
		for (const name of ["ssid", "ip", "mac", "bssid", "rssi"]) {
			const objectString = `Devices.${duid}.networkInfo.${name}`;
			const objectType = name == "rssi" ? "number" : "string";
			await this.createStateObjectHelper(objectString, name, objectType, null, null, "value", true, false);
		}
	}

	async startCommand(duid, command, parameters) {

		if(!this.isInited()){
			this.log.warn("Adapter not inited. Command not executed.");
			return;
		}

	
		switch (command) {
			case "app_zoned_clean":
			case "app_goto_target":
			case "app_start":
			case "app_stop":
			case "stop_zoned_clean":
			case "app_pause":
			case "app_charge":
				this.vacuums[duid].command(duid, command, parameters);
				break;

			case "get_photo":
				this.vacuums[duid].getParameter(duid, "get_photo", parameters);
				break;
			case "sniffing_decrypt":
				await this.getStateAsync("HomeData")
					.then((homedata) => {
						if (homedata) {
							const homedataVal = homedata.val;
							if (typeof homedataVal == "string") {
								// this.log.debug("Sniffing message received!");
								const homedataParsed = JSON.parse(homedataVal);

								this.decodeSniffedMessage(data, homedataParsed.devices);
								this.decodeSniffedMessage(data, homedataParsed.receivedDevices);
							}
						}
					})
					.catch((error) => {
						this.log.error("Failed to decode/decrypt sniffing message. " + error);

					});

				break;
			default:
				this.log.warn(`Command ${command} not found.`);

		}
	}


	isCleaning(state) {
		switch (state) {
			case 4: // Remote Control
			case 5: // Cleaning
			case 6: // Returning Dock
			case 7: // Manual Mode
			case 11: // Spot Cleaning
			case 15: // Docking
			case 16: // Go To
			case 17: // Zone Clean
			case 18: // Room Clean
			case 26: // Going to wash the mop
				return true;
			default:
				return false;
		}
	}

	async getRobotVersion(duid) {
		const homedata = await this.getStateAsync("HomeData");
		if (homedata && homedata.val) {
			const devices = JSON.parse(homedata.val.toString()).devices.concat(JSON.parse(homedata.val.toString()).receivedDevices);

			for (const device in devices) {
				if (devices[device].duid == duid) return devices[device].pv;
			}
		}

		return "Error in getRobotVersion. Version not found.";
	}

	getRequestId() {
		if (this.idCounter >= 9999) {
			this.idCounter = 0;
			return this.idCounter;
		}
		return this.idCounter++;
	}

	async setupBasicObjects() {
		await this.setObjectAsync("Devices", {
			type: "folder",
			common: {
				name: "Devices",
			},
			native: {},
		});

		await this.setObjectAsync("UserData", {
			type: "state",
			common: {
				name: "UserData string",
				type: "string",
				role: "value",
				read: true,
				write: false,
			},
			native: {},
		});

		await this.setObjectAsync("HomeData", {
			type: "state",
			common: {
				name: "HomeData string",
				type: "string",
				role: "value",
				read: true,
				write: false,
			},
			native: {},
		});

		await this.setObjectAsync("clientID", {
			type: "state",
			common: {
				name: "Client ID",
				type: "string",
				role: "value",
				read: true,
				write: false,
			},
			native: {},
		});
	}

	async catchError(error, attribute, duid, model) {
		if (error) {
			if (error.toString().includes("retry") || error.toString().includes("locating") || error.toString().includes("timed out after 10 seconds")) {
				this.log.warn(`Failed to execute ${attribute} on robot ${duid} (${model || "unknown model"}): ${error}`);
			} else {
				this.log.error(`Failed to execute ${attribute} on robot ${duid} (${model || "unknown model"}): ${error.stack || error}`);
			}
		}
	}

	async app_start(duid){
		await this.startCommand(duid, "app_start", null);
	}

	async app_stop(duid){
		await this.startCommand(duid, "app_stop", null);
	}

	async app_charge(duid){
		await this.startCommand(duid, "app_charge", null);
	}

	async getStatus(duid, vacuum) {
		await vacuum.getParameter(duid, "get_status");
	}

	async getStatus(duid) {

		try{
			await this.vacuums[duid].getParameter(duid, "get_status", "state");
		}catch(error){
			this.catchError(error, "getStatus", duid);
		}
	}		

	getProductData(productId) {

		const homedata = this.getStateAsync("HomeData");

		if (homedata && typeof homedata.val == "string") {
			const homedataJSON = JSON.parse(homedata.val);
			const product = homedataJSON.products.find((product) => product.id == productId);

			return product;
		}
	}

	getVacuumDeviceData(duid) {
		const homedata = this.getStateAsync("HomeData");

		if (homedata && typeof homedata.val == "string") {
			const homedataJSON = JSON.parse(homedata.val);
			const device = homedataJSON.devices.find((device) => device.duid == duid);
			const receivedDevice = homedataJSON.receivedDevices.find((device) => device.duid == duid);

			return device || receivedDevice;
		}
	}

	getVacuumSchemaId(duid, code) {
		
		const productId = this.getVacuumDeviceInfo(duid, "productId");
		const product = this.getProductData(productId);		
		
		if (product) {

			const schema = product.schema;
			const schemaId = schema.find((schema) => schema.code == code);

			if (schemaId) {
				return schemaId.id;
			}
		}

		return null;
	
	}

	getVacuumDeviceInfo(duid, property) {

		const device = this.getVacuumDeviceData(duid);

		if (device) {
			return device[property];
		} else {
			return "";
		}	
	}

	getVacuumDeviceStatus(duid, property) {

		const propertyID = this.getVacuumSchemaId(duid, property);

		if(propertyID == null){
			return "";
		}

		const device = this.getVacuumDeviceData(duid);

		if (device.deviceStatus && device.deviceStatus[propertyID] != undefined) {
			return device.deviceStatus[propertyID];
		} 

		return "";


		
	}

	getVacuumList() {

		const homedata = this.getStateAsync("HomeData");

		if (homedata && typeof homedata.val == "string") {
			const homedataJSON = JSON.parse(homedata.val);
			const devices = homedataJSON.devices.concat(homedataJSON.receivedDevices);

			return devices;
		}

		return [];

	}

	setDeviceNotify(callback){
		this.deviceNotify = callback;
	}

}

module.exports = {Roborock};

////////////////////////////////////////////////////////////////////////////////////////////////////

