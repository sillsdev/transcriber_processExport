const AWS = require('aws-sdk');

const timeout = process.env.TIMEOUT;
const queue = process.env.SIL_TR_EXPORT_QUEUE;
const bucket = process.env.SIL_TR_USERFILES_BUCKET;

exports.handler = async function(event, context) {
  console.log('Here we are', event,event.Records.length);
  var sqs = new AWS.SQS();   
  
  async function getFileStream(filekey) {
    const aws = require("aws-sdk");
    const s3 = new aws.S3(); // Pass in opts to S3 if necessary
    var params = {
      Bucket: bucket,
      Key: filekey,
    };
    const stream = s3
      .getObject(params)
      .createReadStream()
      .on("error", (err) => {
        console.log("stream error", err.message);
        return null;
      })
      .on("finish", () => {
        //console.log('stream finish');
      })
      .on("close", () => {
        //console.log("stream close");
      });
    return stream;
  }
  async function FileToBuffer(filekey) {
    var stream = null;
    var tries = 0;
    while (stream === null && tries < 3) {
      try {
        stream = await getFileStream(filekey);
      } catch (e) {
        console.log("key", filekey);
        console.log(e);
      }
      tries++;
    }
    if (stream !== null) {
      const chunks = [];
      for await (let chunk of stream) {
        chunks.push(chunk);
      }
      return Buffer.concat(chunks);
    }
    console.log("stream null");
    return null;
  }

  async function putFile(filekey, body) {
    const aws = require("aws-sdk");
    const s3 = new aws.S3(); 
    console.log('putFile', filekey);
    var params = {
      Bucket: bucket,
      Key: filekey,
      Body: body,
      ContentType: "application/" +  filekey.substring(filekey.lastIndexOf(".")+1),
    };
    console.log(params);
    var mu = s3.upload(params);
    var data = await mu.promise();
    console.log("file saved ", data.Location);
    return data.Location;
  }

  async function exportProjectMedia(info) {
    const AdmZip = require("adm-zip");
    let start = info.Start;
    const secondsOfWork = timeout-30;
    const dtBail = Date.now() + secondsOfWork*1000;
    let bailNow = false;
    const inputKey = info.Folder + '/' + info.PTFFile; 

    var zip = new AdmZip(await FileToBuffer(inputKey));
    var statusFile = inputKey + ".sss";
    var zipEntries = zip.getEntries();
    var deletemf = true;
    var mediafiles = zipEntries.find(
      (e) => e.entryName === "data/Z_attachedmediafiles.json"
    );
    if (!mediafiles) {
      mediafiles = zipEntries.find(
        (e) => e.entryName === "data/H_mediafiles.json"
      );
      deletemf = false;
    }
    if (mediafiles) {
      var mediastr = mediafiles.getData().toString("utf8");
      var media = JSON.parse(mediastr);
      if (Array.isArray(media.data)) {
        for (let ix = start; !bailNow && ix < media.data.length; ix++) {
          var element = media.data[ix];
          console.log(ix.toString(), " of ", media.data.length.toString(), element.attributes["s3file"]);
          if (element.attributes["audio-url"]) {
            try {
              var buf = await FileToBuffer(element.attributes["s3file"]);
              zip.addFile(element.attributes["audio-url"], buf);
            } catch (e) {
              console.log(
                "error adding file",
                element.attributes["audio-url"],
                element.attributes["s3file"]
              );
              console.log(e);
            }
          }
          start += 1;
          bailNow = Date.now() > dtBail;
          if (start % 20 === 0 || bailNow) {
            await putFile(statusFile, start.toString() + " media");
            if (bailNow)
            {
            var buf = zip.toBuffer();
            await putFile(inputKey, buf);
            }
          }
        }
        if (!bailNow) {
          console.log("done", start);
          if (deletemf) zip.deleteFile(mediafiles);
          await putFile(inputKey, zip.toBuffer());
          await putFile(statusFile, "-1");
          start = -1;
        }
      }
    }
    else {
      await putFile(statusFile, "-1");
      start = -1;
    }
    return start;
  }

  function sendMsg(params, successCallback, errorCallback) {
    sqs.sendMessage(params, function(err, data) {
      if (err) {
        console.log(err);
        errorCallback(err);
      } else {
        console.log(data.MessageId);
        successCallback(data.MessageId);
      }
    });
  }

  async function sendMsgWrap(params)
  {
    return new Promise((resolve, reject) => {
      sendMsg(params, (successResponse) => {resolve(successResponse)}, (errorResponse) => reject(errorResponse))
    })
  }
  

  try {
    const { body ,attributes} =  event.Records[0];
      var info = JSON.parse(body)
      var start = await exportProjectMedia(info);
      if (start > 0)
      {
        //send a message to start again
        var params = {
          MessageBody:JSON.stringify({...info, Start:start}),
          MessageDeduplicationId: attributes.MessageGroupId + "_" + start.toString(),
          MessageGroupId:attributes.MessageGroupId,
          QueueUrl: queue
        };
        console.log(params);
        const result = await sendMsgWrap(params);
      }
      /*
        var deleteParams = {
          QueueUrl: queue,
          ReceiptHandle: msg.receiptHandle
        };
        console.log('deleteParams', deleteParams);
        sqs.deleteMessage(deleteParams, function(err, data) {
          if (err) {
            console.log("Delete Error", err);
          } else {
            console.log("Message Deleted", data);
          }
        });
        */
      }
      catch (err) {
          console.log(err.toString());
      }

  
}
