
const WebSocket = require('ws');
const EventEmitter = require('events');
const lockfile = require('process-lockfile');
const os = require('os');

const config = require('./config');

var tmpdir = os.tmpdir();

class ChromeBridgeServer extends EventEmitter
{
	constructor(options)
	{
		super();

		if(options == null)
		{
			options = {};
		}

		this._options = options;
		/*
		{
			verbose: boolean,
			port: integer,
			host: string
		}
		*/

		this._serverStartTime = null;
		this._server = null;
		this._chromeClients = [];
		this._clients = [];

		this._requestIdCounter = 0;
		this._pendingRequests = [
			/*
			{
				requestId: integer,
				chromeClient: WebSocket,
				completion: function
			}
			*/
		];

		this._waitingClients = [
			/*
			{
				requestId: integer,
				client: WebSocket,
				completion: function
			}
			*/
		];
	}

	_verboseLog(message)
	{
		if(this._options.verbose)
		{
			console.error(message);
		}
	}

	static isServerRunning(port)
	{
		return lockfile.isLockedSync(tmpdir+'/chrome-cmd-'+port, {});
	}

	listen(completion)
	{
		// create server
		var port = this._options.port || config.PORT;
		var host = this._options.host || config.HOST;

		lockfile.lock(tmpdir+'/chrome-cmd-'+port).then(() => {
			this._serverStartTime = new Date().getTime();
			this._server = new WebSocket.Server({ port: port, host: host });
			this._port = port;
			this._host = host;
			this._chromeClients = [];
			this._clients = [];
			this._waitingClients = [];

			this._verboseLog("initializing server");

			var serverListening = false;

			this._server.on('error', (error) => {
				// error
				if(!serverListening)
				{
					this._verboseLog("server initialization failed: "+error.message);
					this.close(() => {
						this.emit('failure', error);
						if(completion)
						{
							completion(error);
						}
					});
				}
				else
				{
					this._verboseLog("server error: "+error.message);
					this.emit('error', error);
				}
			});

			this._server.on('listening', () => {
				// server is listening
				serverListening = true;
				this._verboseLog("server is listening at "+host+":"+port);
				this.emit('listening');
				if(completion)
				{
					completion(null);
				}
			});

			this._server.on('headers', (headers, request) => {
				//
			});

			this._server.on('connection', (client, request) => {
				// connection opened
				if(request.headers.origin != null && request.headers.origin.startsWith("chrome-extension://")
					&& request.connection.remoteAddress == '127.0.0.1' && request.headers['x-forwarded-for'] == null
					&& request.headers.host == config.HOST+':'+config.PORT)
				{
					// chrome connection
					this._verboseLog("chrome client connected");

					this._chromeClients.push(client);

					client.on('message', (data) => {
						this._verboseLog("received message from chrome client:");
						this._verboseLog(data);

						var message = JSON.parse(data);
						if(message == null)
						{
							this._verboseLog("bad message");
							return;
						}
						this._handleChromeMessage(client, message);
					});

					client.on('close', (code, reason) => {
						var index = this._chromeClients.indexOf(client);
						if(index != -1)
						{
							this._chromeClients.splice(index, 1);
						}
						this._handleChromeDisconnect(client);
						this.emit('chrome-disconnect', client);
					});

					this._handleChromeConnect(client);
					this.emit('chrome-connect', client);
					return;
				}
				else
				{
					// client connection
					this._verboseLog("client connected");

					this._clients.push(client);

					client.on('message', (data) => {
						this._verboseLog("received message from client:");
						this._verboseLog(data);

						var message = JSON.parse(data);
						if(message == null)
						{
							this._verboseLog("bad message");
							return;
						}
						this._handleClientMessage(client, message);
					});

					client.on('close', (code, reason) => {
						var index = this._clients.indexOf(client);
						if(index != -1)
						{
							this._clients.splice(index, 1);
						}
						this._handleClientDisconnect(client);
						this.emit('client-disconnect', client);
					});

					this._handleClientConnect(client);
					this.emit('client-connect', client);
					return;
				}
			});
		}).catch((error) => {
			this.emit('failure', error);
			completion(error);
		});
	}

	_handleClientConnect(client)
	{
		//
	}

	_handleClientDisconnect(client)
	{
		//
	}

	_handleClientMessage(client, message)
	{
		if(typeof message.requestId != 'number')
		{
			this.sendError(client, message.requestId, new Error("bad request"));
			return;
		}
		else if(typeof message.content != 'object')
		{
			this.sendError(client, message.requestId, new Error("bad request"));
			return;
		}

		// handle special server commands
		switch(message.content.command)
		{
			case 'wait-for-chrome':
				if(this._chromeClients.length > 0)
				{
					var response = {
						chromeConnected: true
					};
					this.sendResponse(client, message.requestId, response);
					return;
				}
				this._waitingClients.push({
					requestId: message.requestId,
					client: client,
					completion: (connected) => {
						var response = {
							chromeConnected: connected
						};
						this.sendResponse(client, message.requestId, response);
					}
				});
				return;
		}

		// forward client message to chrome extension
		this.sendChromeMessage(message.content, (response, error) => {
			if(error)
			{
				this.sendError(client, message.requestId, error);
			}
			else
			{
				this.sendResponse(client, message.requestId, response);
			}
		});
	}

	_handleChromeConnect(client)
	{
		var waitingClients = this._waitingClients;
		this._waitingClients = [];
		for(var i=0; i<waitingClients.length; i++)
		{
			waitingClients[i].completion(true);
		}
	}

	_handleChromeDisconnect(client)
	{
		for(var i=0; i<this._pendingRequests.length; i++)
		{
			var request = this._pendingRequests[i];
			if(request.chromeClient == client)
			{
				this._pendingRequests.splice(i, 1);
				i--;
				request.completion(null, new Error("chrome disconnected"));
			}
		}
	}

	_handleChromeMessage(chromeClient, message)
	{
		if(message.responseId === undefined)
		{
			this._verboseLog("received bad response from chrome extension");
			return;
		}
		// forward response to client
		for(var i=0; i<this._pendingRequests.length; i++)
		{
			var request = this._pendingRequests[i];
			if(request.requestId == message.responseId)
			{
				this._pendingRequests.splice(i, 1);
				if(chromeClient != request.chromeClient)
				{
					this._verboseLog("chrome client sending response does not match chrome client that received request. Possible hijacking?");
					request.completion(null, new Error("responder does not match request recipient. Possible hijacking?"));
					return;
				}
				if(!message.success)
				{
					this._verboseLog("request was not successful. forwarding error to client...");
					request.completion(null, new Error(message.error));
					return;
				}
				this._verboseLog("forwarding message content to client");
				request.completion(message.content, null);
				return;
			}
		}
		this._verboseLog("no matching request for response:");
		this._verboseLog(JSON.stringify(message));
	}

	sendError(client, responseId, error)
	{
		var response = {
			responseId: responseId,
			success: false,
			error: error.message
		};
		client.send(JSON.stringify(response));
	}

	sendResponse(client, responseId, message)
	{
		var response = {
			responseId: responseId,
			success: true,
			content: message
		};
		client.send(JSON.stringify(response));
	}

	sendChromeMessage(message, completion)
	{
		if(this._chromeClients.length == 0)
		{
			completion(null, new Error("chrome extension is not connected"));
			return;
		}

		var requestId = this._requestIdCounter;
		this._requestIdCounter++;

		var request = {
			requestId: requestId,
			content: message,
		};

		var chromeClient = this._chromeClients[0];
		chromeClient.send(JSON.stringify(request));

		this._pendingRequests.push({
			requestId: requestId,
			chromeClient: chromeClient,
			completion: (response, error) => {
				completion(response, error);
			}
		});
	}

	close(completion)
	{
		this._server.close(() => {
			this._serverStartTime = null;
			this._server = null;
			this._port = null;
			this._host = null;
			this._chromeClients = [];
			this._clients = [];

			this._requestIdCounter = 0;
			this._pendingRequests = [];

			this._waitingClients = [];

			lockfile.unlock(tmpdir+'/chrome-cmd-'+port).then((error) => {
				this.emit('close');
				if(completion)
				{
					completion();
				}
			});
		});
	}
}

module.exports = ChromeBridgeServer;