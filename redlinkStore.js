const httpsServer = require('./https-server.js');
const alasql = require('alasql');
const request = require('request').defaults({strictSSL: false});
const fs = require('fs-extra');

let RED;
module.exports.initRED = function (_RED) {
    RED = _RED;
};

module.exports.RedLinkStore = function (config) {
    const notifyDirections = {
        NORTH: 'north',
        SOUTH: 'south',
        LOCAL: 'local',
        STORE: 'store',
        RESYN: 'reSync'
    };

    RED.nodes.createNode(this, config);
    const node = this;
    const log = require('./log.js')(node).log;

    node.reSyncTime = 30000; // This timer defines the routing mesh sync for any messages.
    node.consumerlifeSpan = 120 // 2 Minutes;
    node.reSyncTimerId = {};
    node.listenAddress = config.listenAddress;
    node.listenPort = config.listenPort;
    node.southInsert = config.southInsert;
    node.meshName = config.meshName;
    node.name = config.meshName ? config.meshName + ':' + config.name : config.name;
    node.notifyInterval = config.notifyInterval;
    node.functions = config.functions;
    node.northPeers = config.headers; //todo validation in ui to prevent multiple norths with same ip:port
    node.southPeers = []; //todo each store should notify its north peer once when it comes up- that's how southPeers will be populated
    node.command = true;
    node.registration = config.showRegistration;
    node.debug = config.showDebug;
    const largeMessagesDirectory = require('./redlinkSettings.js')(RED, node.name).largeMessagesDirectory;
    const largeMessageThreshold = require('./redlinkSettings.js')(RED, node.name).largeMessageThreshold;
    // Insert myself into the mesh.
    const insertStoreSql = 'INSERT INTO stores("' + node.name + '","' + node.listenAddress + '",' + node.listenPort + ')';
    alasql(insertStoreSql);

    function sendMessage(msg) { //command, registration, debug
        const msgs = [];
        if (node.command) {
            msgs.push(msg.command);
        }
        if (node.registration) {
            msgs.push(msg.registration);
        }
        if (node.debug) {
            msgs.push(msg.debug);
        }
        node.send(msgs);
    }

    function notifyPeerStoreOfLocalConsumers(address, port, transitAddress, transitPort) {
        // first get distinct local consumers
        const localConsumersSql = 'SELECT DISTINCT * FROM localStoreConsumers WHERE storeName="' + node.name + '"';
        const localConsumers = alasql(localConsumersSql);
        localConsumers.forEach(consumerS => {
            let qualifiedLocalConsumers = [];
            qualifiedLocalConsumers.push({
                localStoreName: node.name,
                storeName: consumerS.storeName,
                serviceName: consumerS.serviceName,
                consumerId: consumerS.consumerId,
                storeAddress: address,
                storePort: port,
                transitAddress: transitAddress,
                transitPort: transitPort,
                direction: 'local',
                hopCount: 0,
                ttl: Math.floor(new Date().getTime() / 1000)+node.consumerlifeSpan //Setup the overall lifetime for this service, its epoch secs + overall lifespan in secs
            });
            let consumer = qualifiedLocalConsumers[0]; //todo filter this for unique consumers
            let body = {
                consumer,
                notifyType: 'consumerRegistration'
            };

            if (address && address !== '0.0.0.0') {
                sendMessage({ registration: { storeName: node.name, action: 'notifyRegistration', function: 'notifyPeerStoreOfLocalConsumers', notifyData: body } });
                sendMessage({ debug: { storeName: node.name, action: 'notifyRegistration', direction: 'outBound', notifyData: body } });
                const options = {method: 'POST', url: 'https://' + address + ':' + port + '/notify', body, json: true};
                request(options, function (error, response) {
                    if (error) {
                        sendMessage({ debug: { storeName: node.name, action: 'notifyRegistrationResult', direction: 'outBound', notifyData: body, error: error } });
                    } else {
                        sendMessage({ debug: { storeName: node.name, action: 'notifyRegistrationResult', direction: 'outBound', notifyData: response.body      } });
                    }
                });
            }
        });
    }

    function deleteSouthPeer (address,port,peer) {  
      return peer.filter(function(addressPort) {
        return addressPort != address+':'+port;
        });
    };

    function deleteGlobalStoreConsumers(store, direction, address, port) {
      const deleteSql = 'delete from globalStoreConsumers where localStoreName="'+store+'" and direction="'+direction+'" and transitAddress="'+address+'" and transitPort='+port;
      const deleteResult = alasql(deleteSql);
      return (deleteResult > 0);
    }

    function notifyPeerStoreOfConsumers(consumer, direction, hopCount, address, port, transitAddress, transitPort) {
        consumer.direction = direction;
        consumer.transitAddress = transitAddress;
        consumer.transitPort = transitPort;
        consumer.hopCount = hopCount;
        let body = {
            consumer,
            notifyType: 'consumerRegistration'
        };
        if (address && address !== '0.0.0.0') {
            sendMessage({ debug: { storeName: node.name, action: 'notifyRegistration', direction: 'outBound', notifyData: body } });
            const options = {method: 'POST', url: 'https://' + address + ':' + port + '/notify', body, json: true};
            request(options, function (error, response) {
               if (error) {
                    //console.log(direction, hopCount, '-',address,'-', port, '-',transitAddress, '-',transitPort);
                    if (direction === 'south') {
                      node.southPeers = deleteSouthPeer(address,port, node.southPeers); // Ok, looks like the peer has gone, so, lets delete the peer entry.
                      deleteGlobalStoreConsumers(node.name, direction, address, port);
                      sendMessage({ registration: { storeName: node.name, action: 'notifyDeletePeerConnection', direction: direction, notifyData: address+':'+port, serviceName : consumer.serviceName}});
                    }
             else   
               if (direction === 'north') { // Ok, North Peers are hard wired, if the connection is a problem, then just delete the globalStoreConsumers.
                 if (deleteGlobalStoreConsumers(node.name, direction, address, port)){;
                    sendMessage({ registration: { storeName: node.name, action: 'notifyDeletePeerConsumer',   direction: direction, notifyData: address+':'+port, serviceName : consumer.serviceName}});
                   } 
                 }
                 sendMessage({ debug: { storeName: node.name, action: 'notifyRegistrationResult', direction: 'outBound', notifyData: body, error: error }});
               } 
             else 
               if (direction === 'south' && response.statusCode === 404) {
                 node.southPeers = deleteSouthPeer(address,port, node.southPeers); // Ok, looks like the peer has rejected the update, so, lets delete the peer entry.
                 deleteGlobalStoreConsumers(node.name, direction, address, port);
                 sendMessage({ registration: { storeName: node.name, action: 'notifyDeletePeerConnection', direction: direction, notifyData: address+':'+port, serviceName : consumer.serviceName}});
                    }
             else
               {
                 sendMessage({ debug: { storeName: node.name, action: 'notifyRegistrationResult', direction: 'outBound', notifyData: response.body } });
               }
            });
        }
    }

    function notifyAllNorthPeerStoresOnly() {
        let consumer = {};
        consumer.direction = 'store';
        consumer.transitAddress = node.listenAddress;
        consumer.transitPort = node.listenPort;
        let body = {
            consumer,
            notifyType: 'consumerRegistration'
        };
        node.northPeers.forEach(peer => {
            notifyPeerStoreOfConsumers(consumer, consumer.direction, 0, peer.ip, peer.port, consumer.transitAddress, consumer.transitPort);
        });
    }

    function notifyNorthStoreOfConsumers(consumer, transitAddress, transitPort) {
        node.northPeers.forEach(peer => {
           if (consumer.transitAddress+':'+consumer.transitPort != peer.ip+':'+peer.port) {
              notifyPeerStoreOfConsumers(consumer, notifyDirections.NORTH, consumer.hopCount+1, peer.ip, peer.port, transitAddress, transitPort);
            }
        });
    }

    function notifySouthStoreOfConsumers(consumer, direction, storeAddress, storePort, transitAddress, transitPort) {
        node.southPeers.forEach(peer => {
            var [ip, port] = peer.split(':');
            if (consumer.storeAddress+':'+consumer.storePort !== ip+':'+port) {
               notifyPeerStoreOfConsumers(consumer, direction, consumer.hopCount+1, ip, port, transitAddress, transitPort);
            }
        });
    }

    function notifyAllSouthStoreConsumers(direction) {
        const storeName = node.name;
        const meshName = storeName.substring(0, storeName.indexOf(':')); // Producers can only send to Consumers on the same mesh
        const storeAddressData = alasql('SELECT * FROM stores  WHERE storeName  LIKE "' + storeName + '%"');

        const globalConsumersSql = 'SELECT  DISTINCT serviceName,consumerId from ( select * from globalStoreConsumers WHERE localStoreName LIKE "' + storeName + '%")';// +
        const globalConsumers = alasql(globalConsumersSql);    

        const allConsumers = [...new Set([...globalConsumers])];

        const storeAddress = storeAddressData[0].storeAddress;
        const storePort = storeAddressData[0].storePort;

        allConsumers.forEach(consumer => {
            const dataSql = 'select * from globalStoreConsumers where localStoreName = "' + storeName + '" and serviceName ="' + consumer.serviceName + '" and consumerId = "' + consumer.consumerId + '"';
            const data = alasql(dataSql);
            notifySouthStoreOfConsumers(data[0], direction, storeAddress, storePort, node.listenAddress, node.listenPort);
        });
    }


    const nodeId = config.id.replace('.', '');
    const newMsgTriggerName = 'onNewMessage' + nodeId;
    const registerConsumerTriggerName = 'registerConsumer' + nodeId;

    function getRemoteMatchingStores(serviceName, meshName) {
        const globalStoresSql = 'SELECT distinct transitAddress,transitPort,hopCount FROM globalStoreConsumers WHERE serviceName="' + serviceName + '" AND localStoreName = "' + node.name + '"';
        const matchingGlobalStores = alasql(globalStoresSql);
        const matchingGlobalStoresAddresses = [];
        matchingGlobalStores.forEach(store => {
            matchingGlobalStoresAddresses.push({
                transitStoreAddress: store.transitAddress + ':' + store.transitPort,
                transitHopCount: store.hopCount
            });
        });
        return matchingGlobalStoresAddresses;
    }


    //---------------------------------------------------  Notify Triggers  ---------------------------------------------------------
    try {
        log('newMsgTriggerName:', newMsgTriggerName);
        alasql.fn[newMsgTriggerName] = () => {
            // check if the input message is for this store
            // inMessages (msgId STRING, storeName STRING, serviceName STRING, message STRING)'
            const newMessagesSql = 'SELECT * from inMessages WHERE storeName="' + node.name + '" AND read=' + false +' ORDER BY priority DESC';
            var newMessages = alasql(newMessagesSql);

            const newMessage = newMessages[newMessages.length - 1];
            if (newMessage) {
                const allVisibleConsumers = getAllVisibleConsumers(); //todo optimise this
                //insert one notify for local
                for (const localConsumer of allVisibleConsumers.localConsumers) {
                    if (localConsumer.serviceName === newMessage.serviceName) {
                        const notifyInsertSql = 'INSERT INTO notify VALUES ("' + node.name + '","' + newMessage.serviceName + '","' + node.listenAddress + '",' + node.listenPort + ',"' + newMessage.redlinkMsgId + '","",false,"' + newMessage.redlinkProducerId + '")';
                        alasql(notifyInsertSql);
                        break; //should get only one local consumer with the same name- this is a just in case
                    }
                }
                sendMessage({
                    registration: { //todo rename to notify
                        service: newMessage.serviceName,
                        srcStoreAddress: node.listenAddress,
                        srcStorePort: node.listenPort,
                        redlinkMsgId: newMessage.redlinkMsgId,
                        action: 'producerNotification',
                        redlinkProducerId: newMessage.redlinkProducerId
                    }
                });

                //This notify only handles LOCAL consumers, the /notify listener will do the forwarding
                //stores table contains stores local to this node-red instance, all consumers will contain consumers on stores reachable from this store- even if they are remote, however they are handled by the listener.
                const remoteMatchingStores = [...new Set([...getRemoteMatchingStores(newMessage.serviceName, node.meshName)])];

                remoteMatchingStores.forEach(remoteStore => {
                    const body = {
                        service: newMessage.serviceName,
                        srcStoreAddress: node.listenAddress,
                        srcStorePort: node.listenPort,
                        transitAddress: node.listenAddress,
                        transitPort: node.listenPort,
                        sendersHopCount: remoteStore.transitHopCount,
                        redlinkMsgId: newMessage.redlinkMsgId,
                        notifyType: 'producerNotification',
                        redlinkProducerId: newMessage.redlinkProducerId
                    };
                    const options = {
                        method: 'POST',
                        url: 'https://' + remoteStore.transitStoreAddress + '/notify',
                        body,
                        json: true
                    };
                    request(options, function (error, response) {
                        if (error || response.statusCode !== 200) {
                            sendMessage({debug: {error: true, errorDesc: error || response.body}});
                        }
                    });
                });
            }
        };

        //On local consumer registration, let them all know
        alasql.fn[registerConsumerTriggerName] = () => {
            //Notify my local globalConsumerStore with a default hop count of zero and a transit address of myself...all the localConsumers.
            notifyPeerStoreOfLocalConsumers(node.listenAddress, node.listenPort, node.listenAddress, node.listenPort);
        };

        const createNewMsgTriggerSql =    'CREATE TRIGGER ' + newMsgTriggerName +           ' AFTER INSERT ON inMessages CALL ' +          newMsgTriggerName + '()';
        const createRegisterConsumerSql = 'CREATE TRIGGER ' + registerConsumerTriggerName + ' AFTER INSERT ON localStoreConsumers CALL ' + registerConsumerTriggerName + '()';
        try {
            alasql(createNewMsgTriggerSql);
            alasql(createRegisterConsumerSql);
        } catch (e1) {
        }

    // reSyncStores
    notifyAllNorthPeerStoresOnly(); // Register myself with my North Store
    node.reSyncTimerId = reSyncStores(node.reSyncTime); // This is the main call to sync all of the interconnected stores on startup and it also starts the interval timer.

    } catch (e) {
        log(e);
    }

    if (node.listenPort) {
        try {
            node.listenServer = httpsServer.startServer(+node.listenPort);
        } catch (e) {
            console.log('redlinkStore ',node.name,' Error starting listen server on ', node.listenPort, e);
        }
        if (node.listenServer) {
            node.on('close', (removed, done) => {
                node.listenServer.close(() => {
                    done();
                });
            })
        }
        log('started server at port:', node.listenPort);
    }

    function insertGlobalConsumer(serviceName, consumerId, storeName, direction, storeAddress, storePort, transitAddress, transitPort, hopCount, ttl) {
        const existingGlobalConsumerSql = 'SELECT * FROM globalStoreConsumers WHERE localStoreName="' + node.name + '" AND serviceName="' + serviceName + '" AND consumerId="' + consumerId +
            '" AND storeName="' + storeName + '" AND storeAddress = "' + storeAddress + '" AND storePort = ' + storePort;
        const existingGlobalConsumer = alasql(existingGlobalConsumerSql);
        const insertGlobalConsumersSql = 'INSERT INTO globalStoreConsumers("' + node.name + '","' + serviceName + '","' + consumerId + '","' + storeName + '","' + direction + '","' +
            storeAddress + '",' + storePort + ',"' + transitAddress + '",' + transitPort + ',' + hopCount + ',' + ttl + ')';
        if (!existingGlobalConsumer || existingGlobalConsumer.length === 0) {
            const inserted = alasql(insertGlobalConsumersSql);
        } else {
            const updateConsumerTtl = 'UPDATE globalStoreConsumers SET ttl=' + ttl + '  WHERE localStoreName="' + node.name + '" AND serviceName="' + serviceName + '" AND consumerId="' + consumerId +
                                      '" AND storeName="' + storeName + '" AND storeAddress = "' + storeAddress + '" AND storePort = ' + storePort;
            alasql(updateConsumerTtl);
               // console.log('ServiceName ',serviceName,'  Exists and TTl updated=',alasql(updateConsumerTtl));
               // Possibly Need to add a delete and an insert here for lower hopCount routes, it will reduce the number of notifies on high complexity redlink store layouts.
               // console.log('Insert Failed, globalStore ',node.name, 'service ',serviceName,' has an entry with a hopCount of ',existingGlobalConsumer[0].hopCount,' compared with ',hopCount);
        }
    }


    const app = httpsServer.getExpressApp();

    app.post('/notify', (req, res) => { //todo validation on params
        const notifyType = req.body.notifyType;
        switch (notifyType) {

            case 'consumerRegistration' :

                sendMessage({
                    debug: {
                        storeName: node.name,
                        action: 'notifyConsumerRegistration',
                        direction: 'inBound',
                        Data: req.body
                    }
                });

                const consumer = req.body.consumer;
                const serviceName = consumer.serviceName;
                const consumerId = consumer.consumerId;
                const storeName = consumer.storeName;
                const direction = consumer.direction;
                const storeAddress = consumer.storeAddress;
                const storePort = consumer.storePort;
                const transitAddress = consumer.transitAddress;
                const transitPort = consumer.transitPort;
                const hopCount = consumer.hopCount || 0;
                const ttl = consumer.ttl;

                switch (direction) {

                    case 'store' : // Store only rego, this causes the southPeers list to update;
                        if (!node.southPeers.includes(transitAddress + ':' + transitPort)) {
                            node.southPeers.push(transitAddress + ':' + transitPort);
                        } //Add this call as it is actually a store south calling this north store
                        res.status(200).send({action: 'consumerRegistration', status: 200});
                        break;

                    case 'reSync' : // Just insert or refresh the globalConsumers entries, no other action.
                        insertGlobalConsumer(serviceName, consumerId, storeName, direction, storeAddress, storePort, transitAddress, transitPort, hopCount, ttl);
                        res.status(200).send({action: 'consumerRegistration', status: 200});
                        break;

                    case 'local' :  //Connection is connecting from the local consumer 
                        insertGlobalConsumer(serviceName, consumerId, storeName, direction, storeAddress, storePort, transitAddress, transitPort, hopCount, ttl);
                        notifyNorthStoreOfConsumers(consumer, storeAddress, storePort);  // Pass the registration forward to the next store
                        notifySouthStoreOfConsumers(consumer, notifyDirections.SOUTH, storeAddress, storePort, node.listenAddress, node.listenPort);  
                        res.status(200).send({action: 'consumerRegistration', status: 200});
                        break;

                    case 'north' : //Connection is connecting from the South and this is why the routing is indicating that the serviceName is south of this store
                        //console.log('southInsert=',node.southInsert);
                        if (node.southInsert) {
                           insertGlobalConsumer(serviceName, consumerId, storeName, 'south', storeAddress, storePort, transitAddress, transitPort, hopCount, ttl);
                           notifyNorthStoreOfConsumers(consumer, node.listenAddress, node.listenPort); // Pass the registration forward to the next store
                           notifyAllSouthStoreConsumers(notifyDirections.SOUTH);                       // Pass the resistration to any other south store
                        }   
                        res.status(200).send({action: 'consumerRegistration', status: 200});
                        break;

                    case 'south' : //Connection is connecting from the North and this is why the routing is indicating that the serviceName is north of this store
                        if (node.northPeers.filter( x=> x.ip == transitAddress&&x.port == transitPort.toString() ).length > 0) {
                          insertGlobalConsumer(serviceName, consumerId, storeName, 'north', storeAddress, storePort, transitAddress, transitPort, hopCount, ttl);
                          notifySouthStoreOfConsumers(consumer, notifyDirections.SOUTH, storeAddress, storePort, node.listenAddress, node.listenPort);
                          res.status(200).send({action: 'consumerRegistration', status: 200});
                        } else
                        {
                          res.status(404).send({action: 'consumerRegistration', status: 404}); 
                        }
                        break;
                }

                break;


            case 'producerNotification' :

                sendMessage({
                    debug: {
                        storeName: node.name,
                        action: 'producerNotification',
                        direction: 'Received',
                        Data: req.body
                    }
                });

                const existingLocalConsumerSql = 'SELECT * FROM localStoreConsumers WHERE storeName="' + node.name + '" AND serviceName="' + req.body.service + '"';
                const localCons = alasql(existingLocalConsumerSql);
                if (localCons.length > 0) {
                    //If this store has a local consumer on it then send out a local notify, note no forwarding will happen from this store.
                    const existingNotifySql = 'SELECT * FROM notify WHERE storeName="' + node.name + '" AND serviceName="' + req.body.service +
                        '" AND srcStoreAddress="' + req.body.srcStoreAddress + '" AND srcStorePort=' + req.body.srcStorePort +
                        ' AND redlinkMsgId="' + req.body.redlinkMsgId + '"';
                    const existingNotify = alasql(existingNotifySql);
                    if (!existingNotify || existingNotify.length === 0) {
                        sendMessage({
                            debug: {
                                storeName: node.name,
                                action: 'producerNotification',
                                direction: 'LocalConsumerNotify',
                                Data: req.body
                            }
                        });
                        const notifyInsertSql = 'INSERT INTO notify VALUES ("' + node.name + '","' + req.body.service + '","' + req.body.srcStoreAddress + '",' + req.body.srcStorePort + ',"' + req.body.redlinkMsgId + '","",false,"' + req.body.redlinkProducerId + '")';
                        alasql(notifyInsertSql);
                    }
                } else {
                    const remoteMatchingStores = [...new Set([...getRemoteMatchingStores(req.body.service, node.meshName)])];
                    remoteMatchingStores.forEach(remoteStore => {
                        const body = {
                            service: req.body.service,
                            srcStoreAddress: req.body.srcStoreAddress,
                            srcStorePort: req.body.srcStorePort,
                            transitAddress: node.listenAddress,
                            transitPort: node.listenPort,
                            sendersHopCount: req.body.sendersHopCount,
                            redlinkMsgId: req.body.redlinkMsgId,
                            notifyType: 'producerNotification',
                            redlinkProducerId: req.body.redlinkProducerId
                        };
                        sendMessage({
                            debug: {
                                storeName: node.name,
                                action: 'producerForwardNotification',
                                direction: 'RemoteConsumerNotify',
                                Data: req.body
                            },
                            registration: {
                                storeName: node.name,
                                action: 'producerForwardNotification',
                                direction: 'RemoteConsumerNotify',
                                Data: req.body
                            }
                        });
                        const originatorStoreAddress = req.body.transitAddress + ':' + req.body.transitPort;
                        const destinationStoreAddress = remoteStore.transitStoreAddress;
                        const options = {
                            method: 'POST',
                            url: 'https://' + remoteStore.transitStoreAddress + '/notify',
                            body,
                            json: true
                        };
                        //If this store has a consumer on it then send out a peer notify  , the hopcount must be less than the sender and the transitStoreAddress cannot be back to the sender
                        if (req.body.sendersHopCount > remoteStore.transitHopCount && originatorStoreAddress !== destinationStoreAddress) {
                            sendMessage({
                                debug: {
                                    storeName: node.name,
                                    action: 'producerNotification',
                                    direction: 'Forward to ' + remoteStore.transitStoreAddress,
                                    Data: req.body
                                }
                            });
                            request(options, function (error, response) {
                                if (error || response.statusCode !== 200) {
                                    sendMessage({debug: {error: true, errorDesc: error || response.body}});
                                }
                            });
                        }

                    }); //RemoteMatchingStores
                }

                res.status(200).send({action: 'producerNotification', status: 200});
                break;
        } //case
    }); // notify

    app.post('/read-message', (req, res) => {
        const redlinkMsgId = req.body.redlinkMsgId;
        sendMessage({debug: {storeName: node.name, action: 'read-message', direction: 'inBound', Data: req.body}});
        if (!redlinkMsgId) {
            sendMessage({
                debug: {
                    storeName: node.name,
                    action: 'read-message',
                    direction: 'outBound',
                    error: 'redlinkMsgId not specified-400'
                }
            });
            res.status(400).send({err: 'redlinkMsgId not specified'});
            return;
        }
        const msgSql = 'SELECT * FROM inMessages WHERE redlinkMsgId="' + redlinkMsgId + '" AND read=' + false;
        const msgs = alasql(msgSql);//should get one or none
        if (msgs.length > 0) { //will be zero if the message has already been read
            sendMessage({
                debug: {
                    storeName: node.name,
                    action: 'read-message',
                    direction: 'outBound',
                    Data: msgs[msgs.length - 1],
                    error: 'none'
                }
            });
            const message = msgs[0];
            const isLargeMessage = message.isLargeMessage;
            if (isLargeMessage) {
                const path = largeMessagesDirectory + redlinkMsgId +'/message.txt';
                //read msg from path
                msgs[0].message = fs.readFileSync(path, 'utf-8');
            }
            res.send(msgs[0]); //send the oldest message first
            if (msgs[0].sendOnly) {            //delete if send only
                const deleteMsgSql = 'DELETE FROM inMessages WHERE redlinkMsgId="' + redlinkMsgId +'"';
                const deleteMsg = alasql(deleteMsgSql);
            } else {
                //update message to read=true
                const updateMsgStatus = 'UPDATE inMessages SET read=' + true + ' WHERE redlinkMsgId="' + msgs[0].redlinkMsgId + '"';
                alasql(updateMsgStatus);
            }
        } else {
            sendMessage({
                debug: {
                    storeName: node.name,
                    action: 'read-message',
                    direction: 'outBound',
                    error: 'No unread messages'
                }
            });
            const msg = redlinkMsgId ? 'Message with id ' + redlinkMsgId + ' not found' : 'No unread messages';
            res.status(404).send({error: true, msg});
        }
    });

    app.post('/reply-message', (req, res) => {
        const redlinkMsgId = req.body.redlinkMsgId;
        const redlinkProducerId = req.body.redlinkProducerId;
        // const replyingService = req.body.replyingService;
        const message = req.body.payload;
        sendMessage({
            debug: {
                storeName: node.name, action: 'reply-message', direction: 'inBound', Data: req.body
            }
        });
        const replyMsgSql = 'SELECT DISTINCT * FROM replyMessages WHERE redlinkMsgId="' + redlinkMsgId + '"';
        const replyMsg = alasql(replyMsgSql);
        if (replyMsg.length === 0) {
            let insertReplySql;
            if(isLargeMessage(message)){
                //store reply to disk
                const path = largeMessagesDirectory + redlinkMsgId + '/';
                fs.outputFileSync(path + 'reply.txt', message);
                insertReplySql = 'INSERT INTO replyMessages ("' + node.name + '","' + redlinkMsgId + '","' + redlinkProducerId + '","' + '' + '", false, true)';
            }else{
                insertReplySql = 'INSERT INTO replyMessages ("' + node.name + '","' + redlinkMsgId + '","' + redlinkProducerId + '","' + message + '", false, false)';
            }
            alasql(insertReplySql);
            res.status(200).send({msg: 'Reply received for ', redlinkMsgId: redlinkMsgId});
        } else {
            res.status(404).send({msg: 'Reply Rejected for ', redlinkMsgId: redlinkMsgId});
        }
    });


    function deleteOldConsumers() {
      const selectSql = 'select * from globalStoreConsumers where localStoreName = "'+node.name+'" and ttl <= '+ Math.floor(new Date().getTime() / 1000);
      const deleteSql = 'delete   from globalStoreConsumers where localStoreName = "'+node.name+'" and ttl <= '+ Math.floor(new Date().getTime() / 1000);
      const selectData = alasql(selectSql);
      if (selectData && selectData.length > 0) {
        sendMessage({
            registration: {
                storeName: node.name,
                action: 'deleteConsumer',
                direction: 'outBound',
                Data: {record:selectData,time:Math.floor(new Date().getTime() / 1000)},
                error: 'none'
                }
            });
        alasql(deleteSql);
      }
    }

    function reSyncStores(timeOut) {
        return setInterval(function () {
           // First get any local consumers that I own and update my own global entries in my own store, this updates ttl.
           notifyPeerStoreOfLocalConsumers(node.listenAddress, node.listenPort, node.listenAddress, node.listenPort);
           deleteOldConsumers();              // Next  clean up my store first to remove old entries that have not renewed themselves
           notifyAllNorthPeerStoresOnly();    // Make sure the north store knows about me.
        },timeOut);    
    }

    function isLargeMessage(encodedReplyMessage) {
        return encodedReplyMessage.length > largeMessageThreshold;
    }

    function getAllVisibleServices() {
        const globalConsumersSql = 'SELECT serviceName FROM globalStoreConsumers WHERE localStoreName="' + node.name + '"';
        const globalConsumers = alasql(globalConsumersSql);
        let   myServices = [];
          globalConsumers.forEach(consumer => {
             myServices.push(consumer.serviceName);
        });
        return myServices;
    }

    function getAllVisibleConsumers() {
        const localConsumersSql = 'SELECT DISTINCT * FROM localStoreConsumers WHERE storeName="' + node.name + '"';
        const globalConsumersSql = 'SELECT * FROM globalStoreConsumers WHERE localStoreName="' + node.name + '"';
        const storesSql = 'SELECT * FROM stores where storeName ="' + node.name + '"';
        const localConsumers = alasql(localConsumersSql);
        const globalConsumers = alasql(globalConsumersSql);
        const store = alasql(storesSql);
        const peers = {"northPeers": node.northPeers, "southPeers": node.southPeers};
        return {
            localConsumers,
            globalConsumers,
            store,
            peers
        };
    }

    function getCurrentStoreData() {
        const messagesSql = 'SELECT * FROM inMessages    where storeName ="' + node.name + '"';
        const notifiesSql = 'SELECT * FROM notify        where storeName ="' + node.name + '"';
        const repliesSql = 'SELECT * FROM replyMessages where storeName ="' + node.name + '"';
        const storeSql = 'SELECT * FROM stores        where storeName ="' + node.name + '"';
        const messages = alasql(messagesSql);
        const notifies = alasql(notifiesSql);
        const replies = alasql(repliesSql);
        const store = alasql(storeSql);
        return {
            store,
            messages,
            notifies,
            replies
        };
    }

    node.on("input", msg => {
        log(msg);
        switch (msg.topic) {
            case 'listServices' : {
                sendMessage({command: {services : getAllVisibleServices()}});
                break;
            }
            case 'listRegistrations' : {
                sendMessage({command: getAllVisibleConsumers()});
                break;
            }
            case 'listStore'         : {
                sendMessage({command: getCurrentStoreData()});
                break;
            }
            case 'flushStore'        : {
                const removeReplySql = 'DELETE FROM replyMessages WHERE storeName="' + node.name + '"';
                const removeNotifySql = 'DELETE FROM notify        WHERE storeName="' + node.name + '"';
                const removeInMessagesSql = 'DELETE FROM inMessages    WHERE storeName="' + node.name + '"';
                alasql(removeReplySql);
                alasql(removeNotifySql);
                alasql(removeInMessagesSql);
                sendMessage({command: getCurrentStoreData()});
                break;
            }
            default                     : {
                sendMessage({command: {help: "msg.topic can be listRegistrations listStore flushStore"}});
                break;
            }
        }
    });

    node.on('close', (removed, done) => {
        clearInterval(node.reSyncTimerId);
        node.northPeers = config.headers;
        node.southPeers = [];

        //also delete all associated consumers for this store name
        // const dropTriggerNewMsg = 'DROP TRIGGER ' + newMsgTriggerName;
        // alasql(dropTriggerNewMsg);
        dropTrigger(newMsgTriggerName);
        // const dropTriggerRegisterConsumer = 'DROP TRIGGER ' + registerConsumerTriggerName;
        // alasql(dropTriggerRegisterConsumer);
        dropTrigger(registerConsumerTriggerName);

        const removeReplySql = 'DELETE FROM replyMessages WHERE storeName="' + node.name + '"';
        const removeNotifySql = 'DELETE FROM notify        WHERE storeName="' + node.name + '"';
        const removeInMessagesSql = 'DELETE FROM inMessages    WHERE storeName="' + node.name + '"';
        alasql(removeReplySql);
        alasql(removeNotifySql);
        alasql(removeInMessagesSql);

        const removeStoreSql = 'DELETE FROM stores WHERE storeName="' + node.name + '"';
        const removeLocalConsumersSql = 'DELETE FROM localStoreConsumers  WHERE storeName="' + node.name + '"';
        const removeGlobalConsumersSql = 'DELETE FROM globalStoreConsumers WHERE localStoreName="' + node.name + '"';
        alasql(removeStoreSql);
        alasql(removeLocalConsumersSql);
        alasql(removeGlobalConsumersSql);
        done();
    });

    function dropTrigger(triggerName) { //workaround for https://github.com/agershun/alasql/issues/1113
        alasql.fn[triggerName] = () => {
        // console.log('\n\n\n\nEmpty trigger called for consumer registration', triggerName);
        }
    }
}; // function

