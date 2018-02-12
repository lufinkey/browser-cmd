#!/usr/bin/env node

const ArgParser = require('./lib/ArgParser');
const BrowserBridgeClient = require('./lib/BrowserBridgeClient');
const BrowserBridgeServer = require('./lib/BrowserBridgeServer');
const UserKeyManager = require('./lib/UserKeyManager');
const JobManager = require('./lib/JobManager');
const Target = require('./lib/Target');
const config = require('./lib/config');
const { URL } = require('url');
const os = require('os');



config.load();

class CLI
{
	constructor(argv, argOptions)
	{
		this.argv = argv;
		this.argOptions = argOptions;

		this.client = null;
		this.server = null;
		this.keyManager = new UserKeyManager();
		this.userKey = null;
	}

	log(...messages)
	{
		if(this.argv.args.verbose)
		{
			console.error(...messages);
		}
	}

	get basedir()
	{
		return __dirname;
	}

	getTarget()
	{
		var target = Target.parse(this.argv.args.target);
		if(target == null)
		{
			target = Target.parse('controller:'+this.argv.args.target);
		}
		return target;
	}

	startServerIfNeeded()
	{
		return new Promise((resolve, reject) => {
			// make sure we're allowed to start a server instance
			if(!this.argv.args.useTemporaryServerFallback)
			{
				resolve();
				return;
			}

			// check if this server is already running and listening
			if(this.server != null && this.server.listening)
			{
				resolve();
				return;
			}

			// check if any server is already running
			if(BrowserBridgeServer.isServerRunning(this.argv.args.port))
			{
				resolve();
				return;
			}

			// create server if it hasn't already been created
			var server = this.server;
			if(server == null)
			{
				this.log("server is not running... starting temporary server");
				var serverOptions = {
					verbose: this.argv.args.verbose,
					port: this.argv.args.port,
					userKeys: {}
				};
				this.userKey = this.keyManager.generateRandomString(24);
				serverOptions.userKeys[os.userInfo().username] = this.userKey;
				server = new BrowserBridgeServer(serverOptions);
				this.server = server;
			}

			// make server start listening
			this.server.listen().then(() => {
				resolve();
			}).catch((error) => {
				if(this.server === server)
				{
					this.server = null;
				}
				reject(error);
			});
		});
	}

	connectToServer()
	{
		return new Promise((resolve, reject) => {
			this.startServerIfNeeded().then(() => {
				// create a client if one has not already been created
				if(this.client == null)
				{
					if(this.userKey == null)
					{
						this.userKey = this.keyManager.getKey(os.userInfo().username, this.argv.args.port);
					}
					var clientOptions = {
						verbose: this.argv.args.verbose,
						port: this.argv.args.port,
						username: os.userInfo().username,
						key: this.userKey
					};
					this.log("attempting connection to server");
					this.client = new BrowserBridgeClient(clientOptions);
				}
				
				// connect client
				this.client.connect().then(resolve).catch(reject);
			}).catch(reject);
		});
	}

	connectToBrowser()
	{
		return new Promise((resolve, reject) => {
			if(this.getTarget() == null)
			{
				reject(new Error("invalid target"));
				return;
			}
			this.connectToServer().then(() => {
				if(this.server == null)
				{
					resolve();
					return;
				}
				
				// if server was temporary, finish if it already has the targetted controller
				if(this.server.getController(this.getTarget()) != null)
				{
					resolve();
					return;
				}

				// wait for the targetted controller to connect
				let timeoutObj = null;
				let registerControllerCallback = null;

				// set a timeout for 6 seconds
				setTimeout(() => {
					this.server.removeListener('registerController', registerControllerCallback);
					reject(new Error("timed out waiting for browser to connect"));
				}, 6000);

				// if we started a temporary server, wait until a controller is received
				registerControllerCallback = (event) => {
					if(Target.match(this.getTarget(), event.socket.browsercmd.getTarget()))
					{
						clearTimeout(timeoutObj);
						this.server.removeListener('registerController', registerControllerCallback);
						resolve();
					}
				};
				this.server.addListener('registerController', registerControllerCallback);
			}).catch(reject);
		});
	}

	performBrowserRequest(request)
	{
		// send a request to the server to forward to chrome
		return this.client.sendRequest(Target.stringify(this.getTarget()), request);
	}

	querySelectors(selectors, definitions, args)
	{
		return new Promise((resolve, reject) => {
			if(args == null)
			{
				args = {};
			}

			// consolidate duplicate selectors
			let uniqueSelectors = Array.from(new Set(selectors));

			// add request(s) to send
			var jobMgr = new JobManager();
			for(var i=0; i<uniqueSelectors.length; i++)
			{
				const selector = uniqueSelectors[i];
				let jobKey = ''+i;
				if(typeof selector == 'string')
				{
					let selectorDefinition = definitions.strings[selector];
					let request = selectorDefinition.createRequest(args);
					jobMgr.addJob(jobKey, this.performBrowserRequest(request));
				}
				else if(typeof selector == 'number')
				{
					let request = definitions.number.createRequest(selector, args);
					jobMgr.addJob(jobKey, this.performBrowserRequest(request));
				}
				else
				{
					reject(new Error("invalid selector "+selector));
					return;
				}
			}

			// send request(s)
			jobMgr.execute((responses, errors) => {
				// display errors
				if(uniqueSelectors.length == 1)
				{
					for(const jobKey in errors)
					{
						console.error(errors[jobKey].message);
					}
				}
				else
				{
					for(var i=0; i<uniqueSelectors.length; i++)
					{
						const selector = uniqueSelectors[i];
						const jobKey = ''+i;
						if(errors[jobKey])
						{
							console.error(selector+': '+errors[jobKey].message);
						}
					}
				}

				// filter and consolidate results
				var results = [];
				for(var i=0; i<uniqueSelectors.length; i++)
				{
					const selector = uniqueSelectors[i];
					var jobKey = ''+i;
					var response = null;
					if(typeof selector == 'string')
					{
						var selectorDefinition = definitions.strings[selector];
						response = responses[jobKey];
						if(response != null && selectorDefinition.filterResponse)
						{
							response = selectorDefinition.filterResponse(response);
						}
					}
					else if(typeof selector == 'number')
					{
						var selectorDefinition = definitions.number;
						response = responses[jobKey];
						if(response != null && selectorDefinition.filterResponse)
						{
							response = selectorDefinition.filterResponse(response);
						}
					}

					if(response != null && response.length > 0)
					{
						results = results.concat(response);
					}
					else if(!errors[jobKey])
					{
						console.error("no "+definitions.typeName+"s found for selector "+selector);
					}
				}

				// remove duplicate results
				if(definitions.idField)
				{
					for(var i=0; i<results.length; i++)
					{
						var obj = results[i];
						for(var j=(i+1); j<results.length; j++)
						{
							var cmpObj = results[j];
							if(obj[definitions.idField] == cmpObj[definitions.idField])
							{
								results.splice(j, 1);
								j--;
							}
						}
					}
				}

				// give the results to the promise
				resolve(results);
			});
		});
	}

	querySelectorIDs(selectors, definitions, args)
	{
		return new Promise((resolve, reject) => {
			// ensure idField is defined
			if(!definitions.idField)
			{
				resolve([]);
				return;
			}

			// check if there are selectors that aren't IDs
			var hasNonIDSelector = false;
			for(var i=0; i<selectors.length; i++)
			{
				var selector = selectors[i];
				if(typeof selector == 'string')
				{
					hasNonIDSelector = true;
					break;
				}
			}

			// if there are only ID selectors, return the unique selectors
			if(!hasNonIDSelector)
			{
				var resultIDs = Array.from(new Set(selectors));
				resolve(resultIDs);
				return;
			}

			// query the selectors
			this.querySelectors(selectors, definitions, args).then((results) => {
				// get result IDs
				var resultIDs = [];
				for(const result of results)
				{
					resultIDs.push(result[definitions.idField]);
				}
				resolve(resultIDs);
			}).catch(reject);
		});
	}

	getFile(path)
	{
		return new Promise((resolve, reject) => {
			// attempt to stat file from path
			fs.stat(path, (error, stats) => {
				if(!error)
				{
					// if stat was successful, read the contents of the file
					if(stats.isFile())
					{
						fs.readFile(path, {encoding:'utf8'}, (error, data) => {
							if(error)
							{
								reject(error);
								return;
							}
							resolve(data);
						});
					}
					else
					{
						reject(new Error("path is not a file"));
					}
					return;
				}

				try
				{
					// if stat was unsuccessful, attempt to read the file from a URL.
					var url = new URL(path);
					if(url.protocol == 'http' || url.protocol == 'https')
					{
						var url = new URL(file);
						const req = http.request(url, (res) => {
							var data = "";
							res.setEncoding('utf8');
							res.on('data', (chunk) => {
								data += chunk;
							});
							res.on('end', () => {
								resolve(data);
							});
						});
						req.on('error', (error) => {
							reject(error);
						});
						return;
					}
					else
					{
						reject(new Error("Invalid path or URL"));
					}
				}
				catch(error)
				{
					reject(new Error("Invalid path or URL"));
				}
			});
		});
	}

	close()
	{
		return new Promise((resolve, reject) => {
			// if no client, close the server
			if(this.client == null)
			{
				if(this.server == null)
				{
					resolve();
					return;
				}
				this.server.close().then(resolve).catch(reject);
				return;
			}

			// close the client, then the server
			this.client.close().then(() => {
				if(this.server == null)
				{
					resolve();
					return;
				}
				this.server.close().then(resolve).catch(reject);
			}).catch((error) => {
				console.error("an error occurred while closing the client: "+error.message);
				if(this.server == null)
				{
					resolve();
					return;
				}
				this.server.close().then(resolve).catch(reject);
			});
		});
	}
}



// parse arguments
var argOptions = {
	args: [
		{
			name: 'verbose',
			short: 'v',
			type: 'boolean',
			default: false,
			path: ['verbose']
		},
		{
			name: 'port',
			short: 'p',
			type: 'uinteger',
			default: config.options.port,
			path: ['port']
		},
		{
			name: 'target',
			type: 'string',
			default: 'chrome'
		},
		{
			name: 'tmp-server',
			type: 'boolean',
			default: false,
			path: ['useTemporaryServerFallback']
		}
	],
	maxStrays: 0,
	stopIfTooManyStrays: true,
	stopAtError: true,
	errorExitCode: 1
};
var args = process.argv.slice(2);
var argv = ArgParser.parse(args, argOptions);

const cli = new CLI(argv, argOptions);

var command = args[argv.endIndex];
args = args.slice(argv.endIndex+1);

const commandCompletion = (exitCode) => {
	cli.close(() => {
		process.exit(exitCode);
	});
};


// catch exit signals
const exitEvents = [
	'SIGHUP',
	'SIGINT',
	'SIGQUIT',
	'SIGABRT',
	'SIGSEGV',
	'SIGTERM'
];
for(let eventName of exitEvents)
{
	process.on(eventName, (signal) => {
		if(argv.args.verbose)
		{
			console.error("received "+eventName);
			console.error("cleaning up...");
		}
		cli.close().then(() => {
			if(argv.args.verbose)
			{
				console.error("exiting...");
			}
			process.exit(1);
		}).catch((error) => {
			console.error("error closing connection: "+error.message);
			console.error("exiting...");
			process.exit(1);
		});
	});
}


// handle command
switch(command)
{
	case 'build-crx':
		require('./cli/build-crx')(cli, commandCompletion, ...args);
		break;

	case 'service':
		require('./cli/service')(cli, commandCompletion, ...args);
		break;

	case 'js':
		require('./cli/js')(cli, commandCompletion, ...args);
		break;

	case 'window':
		require('./cli/window')(cli, commandCompletion, ...args);
		break;

	case 'tab':
		require('./cli/tab')(cli, commandCompletion, ...args);
		break;

	case undefined:
		//TODO show usage
		console.error("no command specified");
		process.exit(1);
		break;

	default:
		console.error("invalid command "+command);
		process.exit(1);
		break;
}
