import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { Readable } from "stream";
import AdmZip from "adm-zip";

const queue = process.env.SIL_TR_EXPORT_QUEUE;
const bucket = process.env.SIL_TR_USERFILES_BUCKET;
const sqsClient = new SQSClient();
const s3Client = new S3Client();

export const handler = async function(event, context) {
  console.log('Here we are', event,event.Records.length);
 
  async function getFileStream(filekey) {
    const params = {
    Bucket: bucket,
    Key: filekey,
    };
    const command = new GetObjectCommand(params);
    const response = await s3Client.send(command);
    const stream = response.Body; // as Readable;
    stream.on("error", (err) => {
      console.log("stream error", err.message);
      return null;
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
    console.log('putFile', filekey);
    var params = {
      Bucket: bucket,
      Key: filekey,
      Body: body,
      ContentType: "application/" +  filekey.substring(filekey.lastIndexOf(".")+1),
    };
    const command = new PutObjectCommand(params);
    const data = await s3Client.send(command);
    return data.Location;
  }

  async function exportProjectMedia(info, context) {
    let start = info.Start;
    //give myself 6ish minutes to write the file 
    console.log('remaining time', context.getRemainingTimeInMillis(),context.getRemainingTimeInMillis() - 400000);
    const dtBail = Date.now() + (context.getRemainingTimeInMillis() - 400000);
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
          //console.log(ix.toString(), " of ", media.data.length.toString(), element.attributes["s3file"]);
          if (element.attributes["audio-url"]) {
            try {
              var buf = await FileToBuffer(element.attributes["s3file"]);
              if (buf !== null)
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
          if (start % 50 === 0 || bailNow) {
            await putFile(statusFile, start.toString() + " media " + (bailNow ? "writing" : ""));
            if (bailNow)
            {
              var buf = zip.toBuffer();
              await putFile(inputKey, buf);
            }
          }
        }
        if (!bailNow) {
          console.log("done", context.getRemainingTimeInMillis());
          await putFile(statusFile, media.data.length.toString()  + " media writing");
          var x = Date.now();
          if (deletemf) zip.deleteFile(mediafiles);
          var buf = zip.toBuffer();
          console.log("zip toBuffer",Date.now()- x);          
          await putFile(inputKey, buf);
          console.log("write to s3",Date.now()- x);          
          await putFile(statusFile, "-1");
          start = -1;
          console.log("exit", Date.now()- x);
        }
      }
    }
    else {
      await putFile(statusFile, "-1");
      start = -1;
    }
    return start;
  }

  async function sendMsg(params, successCallback, errorCallback) {
    const command = new SendMessageCommand(params);
    const data = await sqsClient.send(command);
    console.log(data.MessageId);
    return data.MessageId;
  }

  try {
    const { body ,attributes} =  event.Records[0];
    var info = JSON.parse(body)
    var start = await exportProjectMedia(info, context);
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
      const result = await sendMsg(params);
    }
  }
  catch (err) {
      console.log(err.toString());
  } 
}
