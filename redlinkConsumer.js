const alasql = require('alasql');
let RED;
module.exports.initRED = function (_RED) {
    RED = _RED;
};

module.exports.RedLinkConsumer = function (config) {
    RED.nodes.createNode(this, config);
    const node = this;
    const log = require('./log.js')(node).log;
    node.name = config.name;
    node.consumerStoreName = config.consumerStoreName;
    node.consumerMeshName = config.consumerMeshName;
    if(node.consumerMeshName){
        node.consumerStoreName = node.consumerMeshName+':'+node.consumerStoreName;
    }else{
        log('\n\n\n\nNo mesh name set for consumer', node.name);
    }
    const msgNotifyTriggerId = 'a' + config.id.replace('.', '');
    const newMsgNotifyTrigger = 'onNotify' + msgNotifyTriggerId;
    log('in constructor of consumer:', node.name);

    alasql.fn[newMsgNotifyTrigger] = () => {
        //check if the notify is for this consumer name with the registered store name
        const notifiesSql = 'SELECT * from notify WHERE storeName="' + node.consumerStoreName + '" AND serviceName="' + node.name + '"' + ' AND notifySent='+ false;
        log('notifiesSql in consumer:', notifiesSql);
        var notifies = alasql(notifiesSql);
        const newNotify = notifies[notifies.length - 1];
        if(!newNotify){
            return; //nothing to do- trigger for some other service
        }
        const updateNotify = 'UPDATE notify SET notifySent='+true+' WHERE redlinkMsgId="'+newNotify.redlinkMsgId+'"';
        alasql(updateNotify);
        log('!@#$%$#@! after updating all notifies:', alasql('SELECT * FROM notify'));
        log('notifies for this consumer:', notifies);
        node.send([newNotify, null]);
    };

    const createTriggerSql = 'CREATE TRIGGER ' + msgNotifyTriggerId + ' AFTER INSERT ON notify CALL ' + newMsgNotifyTrigger + '()';
    log('the sql statement for adding trigger in consumer is:', createTriggerSql);
    alasql(createTriggerSql);
    log('registered notify trigger (',createTriggerSql,') for service ', node.name, ' in store ', node.consumerStoreName);

    //localStoreConsumers (storeName STRING, serviceName STRING)'); 
    //can have multiple consumers with same name registered to the same store
    const insertIntoConsumerSql = 'INSERT INTO localStoreConsumers ("' + node.consumerStoreName + '","' + node.name + '")';
    log('in consumer constructor sql to insert into localStoreConsumer is:', insertIntoConsumerSql);
    alasql(insertIntoConsumerSql);
    log('inserted consumer ', node.name, ' for store ', node.consumerStoreName);

    node.on('close', (removed, done) => {
        //todo deregister this consumer
        log('in close of consumer...', node.name);
        const dropNotifyTriggerSql = 'DROP TRIGGER ' + msgNotifyTriggerId; //todo this wont work- see https://github.com/agershun/alasql/issues/1113
        //clean up like in the redlinkStore- reinit trigger function to empty
        alasql(dropNotifyTriggerSql);
        log('dropped notify trigger...');
        const deleteConsumerSql = 'DELETE FROM localStoreConsumers WHERE storeName="' + node.consumerStoreName + +'"' + 'AND serviceName="' + node.name + '"';
        alasql(deleteConsumerSql); //can have multiple consumers with same name registered to the same store
        log('removed consumer from local store...');
        //TODO use the getlocalNorthSouthConsumers function
        const localConsumersSql = 'SELECT * FROM localStoreConsumers';
        const localConsumers = alasql(localConsumersSql);
        log('all local consumers are:', localConsumers);
        const globalConsumersSql = 'SELECT * FROM globalStoreConsumers';
        const globalConsumers = alasql(globalConsumersSql);
        log(' Global consumers are:', globalConsumers);
        done();
    });

};