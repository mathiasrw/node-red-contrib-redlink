module.exports = function(RED, storeName) {
    this.largeMessagesDirectory = initLargeMessagesDirectory(RED, storeName);
    this.largeMessageThreshold = RED.settings.largeMessageThreshold || 25000;//50kB- 2 bytes per character
    return this;
};

function  initLargeMessagesDirectory(RED, storeName){
    let largeMessagesDirectory;
    if(RED.settings.largeMessagesDirectory){
        largeMessagesDirectory = RED.settings.largeMessagesDirectory;
        if(!largeMessagesDirectory.endsWith('/') && !largeMessagesDirectory.endsWith('\\')){
            largeMessagesDirectory +='/';
        }
    }else{
        largeMessagesDirectory = '/tmp/redlink/';
    }
    largeMessagesDirectory +=  storeName.replace(':','.') + '/';
    return largeMessagesDirectory;
}