const base64 = require('base64-coder-node')();

const encodetype = 'binary';
const decodetype = 'binary';

module.exports.encode = function(obj){
    if(!obj){
        return obj;
    }
    return base64.encode(JSON.stringify(obj), encodetype);
};

module.exports.decode = function(str){
    if(!str){
        return str;
    }
    let returnVal = base64.decode(str, decodetype);
    try {
        returnVal = JSON.parse(returnVal);
    } catch (e) {
    } finally {
        return returnVal;
    }
};