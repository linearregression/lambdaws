var Q = require('q'),
    md5 = require('MD5');
    zip = require('node-zip'),
    uuid = require('uuid'),
    extend = require('extend');
    
var lambda = null,
    _defaultFunctionSettings = {
        memory: 128, // mb
        description: '',
        timeout: 3  // seconds
    };

var _getFunctionHash  = function (func) {
    return md5(func.toString());
    // TODO : add config in hash
};

var _lambdaize = function (userFunc) {
    function _lambda (event, context) {
        var executionSucceeded = true,
            executionError = null;
        // TODO (Next iteration) Move requires elsewhere
        var AWS_sdk = require('aws-sdk'),
            sqs_svc = new AWS_sdk.SQS();

        function _sendToSqs(data, afterSentCallback) {
            // TODO (Next iteration) Check MessageBody length and upload to S3 if too lengthy
            var params = {
                MessageBody: JSON.stringify(data),
                QueueUrl: event.sqsQueueUrl
            };
            sqs_svc.sendMessage(params, function(err) {
                if(err) console.log('Error sending response to sqs'); 
                afterSentCallback();
            });
        }

         function _newCallback(err) {
            var finishExecution = function() { context.done(null, "Lambdaws done"); };
            if(typeof(err) !== 'undefined' && err.isFaulty) {
                _sendToSqs({success: false, data: err, requestId: event.requestId}, finishExecution);
            } 
            else {
                _sendToSqs({success: true, data: arguments, requestId: event.requestId}, finishExecution);
            }
        }

        event.args.push(_newCallback);

        var func = /*user function*/null;

        try {
            func.apply(this, event.args);
        }
        catch(error) {
            _newCallback({isFaulty: true, stack: error.stack, message: error.message});
        }
    }

    return _lambda.toString().replace('/*user function*/null', userFunc.toString());
}

var _uploadFunctionAsync = function (lambdaFunc, config, functionHash) {
    var deferred = Q.defer();

    var handlerName = config.name || 'default';
    var functionAsString = 'exports.' + handlerName + '=' + lambdaFunc + ';';
    var zipFile = zip();
    zipFile.file(handlerName + '.js', functionAsString, {binary: false});
    var zipData = new Buffer(zipFile.generate({
        base64: true,
        compression: 'DEFLATE'
    }), 'base64');

    var params = {
        FunctionName: handlerName.concat('-', functionHash), // TODO Find a better way to name functions?
        FunctionZip: zipData,
        Handler: handlerName + "." + handlerName,
        Mode: 'event', // Even though we invoke manually
        // TODO The Amazon Resource Name (ARN) of the IAM role that Lambda assumes when it executes your function to access any other Amazon Web Services (AWS) resources.
        Role: settings.role,
        Runtime: 'nodejs',
        Description: config.description,
        MemorySize: config.memory,
        Timeout: config.timeout
    };

    // TODO Check if the function is already on Lambda and overwrite it
    lambda.uploadFunction(params, function (err, data) {
        if (err) {
            deferred.reject(err);
        } else {
            deferred.resolve(data);
        }
    });

    return deferred.promise.timeout(settings.uploadTimeout, "Function upload to AWS Lambda timed out.");
};

var _createProxy = function (executionStore, queueInitializedPromise, promise) {
    function proxy() {
        var args = Array.prototype.slice.call(arguments);
        if (typeof(args[args.length - 1]) !== 'function') {
            throw "Expected last argument to be a callback";
        }

        var callb = args.pop();
        var requestId = uuid.v4();

        Q.all([queueInitializedPromise, promise]).spread(function (queueUrl, uploadData) {
            var params = {
                FunctionName: uploadData.FunctionName,
                InvokeArgs: JSON.stringify({
                    args: args,
                    sqsQueueUrl: queueUrl,
                    requestId: requestId
                })
            };

            lambda.invokeAsync(params, function (err, data) {
                if (err) console.log(err, err.stack); // TODO Handle Error gracefully
                else {
                    console.log('-->')
                    executionStore[requestId] = callb;
                }
            });
        });

        promise.catch(function () {
            throw "Could not upload function to S3";
        });
    }

    return proxy;
};


module.exports = function (aws, queueInitializedPromise, executionStore){
    var proxyStore = {};
    lambda = new aws.Lambda()

    this.getCloudedFunction = function (func, configs) {
        var functionConfig = extend(true, {}, _defaultFunctionSettings, configs);
        var functionIdentifier = _getFunctionHash(func);

        if (!proxyStore.hasOwnProperty(functionIdentifier)) {
            var lambdaFunc = _lambdaize(func);
            var uploadPromise = _uploadFunctionAsync(lambdaFunc, functionConfig, functionIdentifier);
            proxyStore[functionIdentifier] = _createProxy(executionStore, queueInitializedPromise, uploadPromise);
        }

        return proxyStore[functionIdentifier];
    };
};