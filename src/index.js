// @ts-check
import archiver from "archiver";
import unzipper from "unzipper";
import AdmZip from "adm-zip";
import { PassThrough, Readable } from "stream";
import { Upload } from "@aws-sdk/lib-storage";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  CopyObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";

const queue = process.env.SIL_TR_EXPORT_QUEUE;
const bucket = process.env.SIL_TR_USERFILES_BUCKET;

const sqsClient = new SQSClient();
const s3Client = new S3Client();

const ManifestFile = "data/Z_attachedmediafiles.json";

/* ───────────────────────── HELPERS ───────────────────────── */

async function getFileStream(filekey) {
  //console.log(`Getting S3 file stream: ${filekey}`);
  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: filekey,
  });
  const response = await s3Client.send(command);
  //console.log(`Got S3 file stream: ${filekey}, size: ${response.ContentLength || 'unknown'}`);
  return {
    stream: /** @type {Readable} */ (response.Body),
    size: response.ContentLength,
  };
}

function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let ended = false;
    let errored = false;
    
    // Add a timeout to detect if stream is hanging (60 seconds)
    const timeout = setTimeout(() => {
      if (!ended && !errored) {
        errored = true;
        cleanup();
        const err = new Error("streamToBuffer timeout: stream did not complete within 60 seconds");
        console.error("streamToBuffer timeout error:", err);
        reject(err);
      }
    }, 60000);
    
    const cleanup = () => {
      clearTimeout(timeout);
      stream.removeListener("data", onData);
      stream.removeListener("error", onError);
      stream.removeListener("end", onEnd);
      stream.removeListener("close", onClose);
    };
    
    const onData = (chunk) => {
      chunks.push(chunk);
    };
    
    const onError = (err) => {
      if (!errored) {
        errored = true;
        cleanup();
        reject(err);
      }
    };
    
    const onEnd = () => {
      if (!ended && !errored) {
        ended = true;
        cleanup();
        resolve(Buffer.concat(chunks));
      }
    };
    
    const onClose = () => {
      // Some streams emit 'close' instead of 'end'
      if (!ended && !errored) {
        ended = true;
        cleanup();
        resolve(Buffer.concat(chunks));
      }
    };
    
    stream.on("data", onData);
    stream.on("error", onError);
    stream.on("end", onEnd);
    stream.on("close", onClose);
    
    // If stream is already ended/closed, resolve immediately
    if (stream.readableEnded || stream.destroyed) {
      cleanup();
      resolve(Buffer.concat(chunks));
    }
  });
}

async function putFile(filekey, body) {
  console.log(
    "putFile",
    filekey,
    filekey.substring(filekey.lastIndexOf(".") + 1) === "sss" ? body : "x"
  );
  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: filekey,
    Body: body,
    ContentType: "text/plain",
  });
  return s3Client.send(command);
}

function extractManifestFromZip(buffer) {
  const zip = new AdmZip(buffer);
  const entry = zip.getEntry(ManifestFile);
  if (!entry) throw new Error("Manifest not found");
  return JSON.parse(entry.getData().toString("utf8"));
}

async function saveManifestToS3(manifest, manifestKey) {
  console.log(`Saving manifest to ${manifestKey}`);
  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: manifestKey,
    Body: JSON.stringify(manifest, null, 2),
    ContentType: "application/json",
  });
  await s3Client.send(command);
  console.log(`Manifest saved to ${manifestKey}`);
}

async function getManifestFromS3(manifestKey) {
  console.log(`Reading manifest from ${manifestKey}`);
  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: manifestKey,
  });
  const response = await s3Client.send(command);
  const buffer = await streamToBuffer(response.Body);
  return JSON.parse(buffer.toString("utf8"));
}

async function deletes3file(key) {
  try {
    await s3Client.send(
      new DeleteObjectCommand({
        Bucket: bucket,
        Key: key,
      })
    );
    console.log(`Deleted ${key}`);
  } catch (err) {
    // Ignore if file doesn't exist
    console.log(`Could not delete ${key}:`, err.message);
  }
}

async function copyZipEntriesAndGetManifest(
  ptfKey,
  archive,
  excludeManifest,
  manifestKey
) {
  console.log("Copying zip entries excluding manifest using adm-zip");
  
  try {
    const ptfObject = await s3Client.send(
      new GetObjectCommand({ Bucket: bucket, Key: ptfKey })
    );
    
    // Convert to buffer for adm-zip
    const zipBuffer = await streamToBuffer(ptfObject.Body);
    const zip = new AdmZip(zipBuffer);
    const entries = zip.getEntries();
    let manifest = null;

    for (const entry of entries) {
      if (entry.entryName === excludeManifest) {
        console.log(`Extracting and saving manifest file: ${entry.entryName}`);
        // Extract manifest and save it
        const manifestData = entry.getData();
        manifest = JSON.parse(manifestData.toString("utf8"));
        await saveManifestToS3(manifest, manifestKey);
        console.log(`Manifest saved to ${manifestKey}`);
        continue;
      }

      console.log(`Copying zip entry: ${entry.entryName}`);

      // Get entry data
      const entryData = entry.getData();
      
      // Append to archive
      archive.append(entryData, { name: entry.entryName });
    }

    console.log(`Copied ${entries.length} entries (excluding manifest)`);
    return manifest;
  } catch (err) {
    console.error("Error copying zip entries:", err);
    throw err;
  }
}
function OutofTime(context) {
  // CHANGE TO DEBUG ONLY! const TIME_TO_WRITE = 360000; //6 minutes
  const TIME_TO_WRITE = 840000; //14 minutes
  return context.getRemainingTimeInMillis() < TIME_TO_WRITE
}

async function addMediaFilesToZip(archive, media, start, context, statusFile) {

  console.log(`Adding media files to zip starting from index ${start}`);

  let currentStart = start;

  for (let ix = start; ix < media.data.length; ix++) {
    const element = media.data[ix];
    const s3key = element.attributes["s3file"];
    const zipName = element.attributes["audio-url"];

    if (!s3key || !zipName) {
      console.log(`Skipping entry ${ix}: missing s3key or zipName`);
      continue;
    }

    if (OutofTime(context)) {
      console.log("Bailing from adding files due to time limit");
      break;
    }

    //console.log(`${ix} adding file ${s3key} as ${zipName}`);

    try {
      const { stream: s3Stream, size: s3Size } = await getFileStream(s3key);
      
      // Read entire file into buffer because we were having issues with the stream to archive
      //console.log(`Reading buffer for ${zipName} (expected size: ${s3Size || 'unknown'})`);
      const fileBuffer = await streamToBuffer(s3Stream);
      //console.log(`Read ${fileBuffer.length} bytes for ${zipName}`);
      
      // Append buffer to archive - synchronous when using a buffer
      archive.append(fileBuffer, { name: zipName, store: false });
      
      currentStart++;

      if (currentStart % 50 === 0) {
        console.log(`Progress: ${currentStart} media files added`);
        await putFile(statusFile, currentStart.toString() + " media " );
      }
    } catch (err) {
      console.error(`Error adding ${s3key} to zip:`, err);
      // Continue with next file
    }
  }

  return currentStart;
}
async function copyZipStreamSafely({
  sourceStream,
  archive,
  label = "zip-copy"
}) {
  console.log(`[${label}] starting copy`);

  const parser = unzipper.Parse({ forceStream: true });

  let entryCount = 0;
  let totalBytes = 0;
  let lastEntryAt = Date.now();
  let completed = false;


  sourceStream.on("error", err => {
    console.error(`[${label}] source stream error`, err);
  });

  // Handle parser errors - ignore AbortError after completion
  parser.on("error", err => {
    if (completed && (/** @type {any} */ (err)).code === "ABORT_ERR") {
      console.warn(`[${label}] ignoring late AbortError on parser`);
      return;
    }
    console.error(`[${label}] parser stream error`, err);
    // Don't throw - let the async iterator handle it
  });

  sourceStream.pipe(parser);

  // watchdog: tells you EXACTLY where it stalled
  const watchdog = setInterval(() => {
    const idle = ((Date.now() - lastEntryAt) / 1000).toFixed(1);
    console.log(
      `[${label}] watchdog: entries=${entryCount}, bytes=${totalBytes}, idle=${idle}s`
    );
  }, 5000);

  try {
    for await (const entry of parser) {
      entryCount++;
      lastEntryAt = Date.now();

      console.log(
        `[${label}] entry #${entryCount} start: ${entry.path}`
      );

      let entryBytes = 0;
      const chunks = [];

      try {
        for await (const chunk of entry) {
          entryBytes += chunk.length;
          chunks.push(chunk);
        }
      } catch (err) {
        console.error(
          `[${label}] entry stream error: ${entry.path}`,
          err
        );
        entry.autodrain()
        throw err;
      }

      const buffer = Buffer.concat(chunks);
      totalBytes += buffer.length;

      console.log(
        `[${label}] entry #${entryCount} drained: ${entry.path} (${buffer.length} bytes)`
      );

      archive.append(buffer, { name: entry.path });

      console.log(
        `[${label}] entry #${entryCount} appended`
      );
    }
    completed = true;
    console.log(
      `[${label}] parser finished: ${entryCount} entries, ${totalBytes} bytes`
    );
    
    // Wait a tick to ensure async iterator fully completes
    await new Promise(resolve => setImmediate(resolve));
    console.log(`[${label}] async iterator fully completed`);
  } catch (err) {
    // 🔑 THIS IS THE FIX: Ignore AbortError after successful completion
    if (completed && err?.code === "ABORT_ERR") {
      console.warn(
        `[${label}] ignoring AbortError after successful completion`
      );
      return;
    }
  
    console.error(`[${label}] parser error`, err);
    throw err;
  } finally {
    clearInterval(watchdog);
    // 🔑 CRITICAL: silence late aborts from unzipper
    // Remove error listeners to prevent unhandled errors after completion
    parser.removeAllListeners("error");
    sourceStream.removeAllListeners("error");
    console.log(`[${label}] removed listeners and cleaned up`);
  }
}
//chatgpt version
async function mergeExtraZipFilesIntoOriginal(ptfKey, tempKey, extraZipKeys) {
  console.log(
    `[merge] starting merge → final=${ptfKey}, temp=${tempKey}, extras=${extraZipKeys.length}`
  );

  // 1️⃣ Read temp zip from S3 (streaming)
  console.log(`[merge] fetching temp zip ${tempKey}`);
  const tempObject = await s3Client.send(
    new GetObjectCommand({ Bucket: bucket, Key: tempKey })
  );

  const tempZipStream = /** @type {Readable} */ (tempObject.Body);

  // 2️⃣ Create output zip + S3 upload
  const zipStream = new PassThrough();
  const archive = archiver("zip", { zlib: { level: 6 } });

  archive.on("warning", err => {
    console.warn("[merge] archive warning", err);
  });
  archive.on("entry", entry => {
    //console.log("[merge] archiver consumed entry:", entry.name); //this fires 
  });
  archive.on("error", err => {
    console.error("[merge] archive error", err);
    zipStream.destroy(err);
    throw err;
  });

  archive.pipe(zipStream);

  console.log(`[merge] starting upload to ${ptfKey}`);
  const upload = new Upload({
    client: s3Client,
    params: {
      Bucket: bucket,
      Key: ptfKey,
      Body: zipStream,
      ContentType: "application/zip"
    }
  });

  // 3️⃣ Copy temp zip entries safely
  console.log("[merge] copying entries from temp zip");
  await copyZipStreamSafely({
    sourceStream: tempZipStream,
    archive,
    label: "merge-temp"
  });

  // 4️⃣ Append extra zip files (as nested zips) - stream directly, don't buffer
  // Don't wait for each stream individually - archiver will process them all
  // We'll wait for all of them when we finalize the archive
  for (const extraZipKey of extraZipKeys) {
    console.log(`[merge] appending extra zip ${extraZipKey}`);

    const extraObject = await s3Client.send(
      new GetObjectCommand({ Bucket: bucket, Key: extraZipKey })
    );

    const extraStream = /** @type {Readable} */ (extraObject.Body);
    const entryName = extraZipKey.substring(extraZipKey.lastIndexOf("/") + 1);
  
    archive.append(extraStream, { name: entryName });

    console.log(`[merge] extra zip appended (will be processed during finalize): ${extraZipKey}`);
  }
  
  console.log(`[merge] all ${extraZipKeys.length} extra zip files appended, ready to finalize`);

  // 5️⃣ Finalize archive
  console.log("[merge] finalizing archive");
  archive.finalize();
  // Give archiver a moment to start processing finalize
  await new Promise(resolve => setImmediate(resolve));
  console.log("[merge] waiting for archive to complete finalization...");

  // listen for events just to know what is happening         
        const cleanup = () => {
          archive.removeListener("end", onEnd);
          archive.removeListener("finish", onFinish);
          archive.removeListener("error", onError);
          zipStream.removeListener("finish", onZipFinish);
          zipStream.removeListener("end", onZipEnd);
          zipStream.removeListener("error", onError);
        };
  
        const doResolve = () => {
            cleanup();
            console.log("[merge] archive finalization complete");
          
        };
  
        const onEnd = () => {
          console.log("[merge] archive ended event");
          doResolve();
        };
  
        const onFinish = () => {
          console.log("[merge] archive finished event");
          doResolve();
        };
  
        const onZipFinish = () => {
          console.log("[merge] zipStream finished event");
          doResolve();
        };
  
        const onZipEnd = () => {
          console.log("[merge] zipStream ended event");
          doResolve();
        };
  
        const onError = (err) => {
          cleanup();
          console.error("[merge] error during finalize:", err);
        };
  
        // Listen for archive events (both finish and end)
        archive.once("end", onEnd);
        archive.once("finish", onFinish); //this is the only one that fires
        archive.once("error", onError);
        
        // Listen for zipStream events
        zipStream.once("finish", onZipFinish);
        zipStream.once("end", onZipEnd);
        zipStream.on("error", onError);
  
   
        // If stream is already finished, resolve immediately
        if (zipStream.writableFinished) {
          console.log("[merge] zipStream already finished, resolving immediately");
        }
   
  // 6️⃣ Wait for upload completion
  console.log("[merge] waiting for upload to complete");
  await upload.done();

  console.log(`[merge] upload complete → ${ptfKey}`);

  // 7️⃣ Cleanup
  console.log("[merge] cleaning up temp + extra zips");
  await deletes3file(tempKey);

  for (const extraZipKey of extraZipKeys) {
    console.log(`[merge] delete extra zip key: ${extraZipKey}`);
    await deletes3file(extraZipKey);
  }

  console.log("[merge] merge complete");
}


function CreateArchive(outputKey) {
  const zipStream = new PassThrough();
  const archive = archiver("zip", { zlib: { level: 6 } });
  archive.pipe(zipStream);

  // Handle archive errors
  archive.on("error", (err) => {
    console.error("Archive error:", err);
    zipStream.destroy(err);
  });

  // Stream zip directly to S3
  const upload = new Upload({
    client: s3Client,
    params: {
      Bucket: bucket,
      Key: outputKey,
      Body: zipStream,
      ContentType: "application/zip",
    },
  });
  return { archive, upload };
}
/* ───────────────────────── EXPORT PROJECT MEDIA (ZIP-BASED) ───────────────────────── */

async function exportProjectMedia(info, context) {
  let start = info.Start;
  const ptfKey = `${info.Folder}/${info.PTFFile}`;
  const statusFile = `${ptfKey}.sss`;
  const manifestKey = `${ptfKey}.json`;
  // Use a temp file since we can't read and write to the same key simultaneously
  //only used if start === 0
  const tempKey = `${ptfKey}.tmp`;
  // Create new zip file for extra media files
  //only used if start > 0
  const extraZipKey = `${ptfKey.substring(
    0,
    ptfKey.lastIndexOf(".")
  )}-${start}.zip`;
  const outputKey = start === 0 ? tempKey : extraZipKey;
  const extraFiles = info.ExtraFiles
  ? info.ExtraFiles.split(";").filter((f) => f)
  : [];
  let justNeedToMerge = false;
  console.log(`Starting export: start=${start}, ptfKey=${ptfKey}`);

  let media;
  let archive;
  let upload;

  if (start === 0) {
    ({ archive, upload } = CreateArchive(tempKey));
    // Copy entries to our new zip fileand extract manifest in one pass
    media = await copyZipEntriesAndGetManifest(
      ptfKey,
      archive,
      ManifestFile,
      manifestKey
    );
  } else {
    // Read manifest from saved JSON file
    console.log("Reading manifest from saved JSON file");
    media = await getManifestFromS3(manifestKey);
    console.log(`Found ${media.data.length} media files in manifest`);
    if (start < (media?.data?.length??0)) {
      ({ archive, upload } = CreateArchive(extraZipKey));
    
      console.log(`Creating extra zip file: ${extraZipKey}`);
      // Update extra files list
      extraFiles.push(extraZipKey);
    }
    else justNeedToMerge = true;
  }
  console.log(`Found ${media.data.length} media files in manifest`);
  if (!media || !Array.isArray(media.data)) {
    await putFile(statusFile, "-1");
    return { start: -1, extraFiles: extraFiles };
  }
  if (!justNeedToMerge) {
    if (!archive || !upload) {
      await putFile(statusFile, "-2");
      return { start: -2, extraFiles: extraFiles };
    }
    // Add media files
    console.log("Adding media files to zip");
    start = await addMediaFilesToZip(archive, media, start, context, statusFile);
    console.log('returned from addMediaFilesToZip - start finalize', start);
    // Finalize the archive
    archive.finalize();
    console.log('finalized archive');
    // Wait for upload to complete
    await upload.done();
    console.log(`Zip uploaded to ${outputKey} (will merge with extra files when done)`);
  }
  // Update status
  if (start >= media.data.length && !OutofTime(context)) {
    // Done - merge tempKey and extra zip files into final ptfKey
    if (extraFiles.length === 0) {
      // Only tempKey exists, just rename it
      console.log(`Renaming ${tempKey} to ${ptfKey}`);
      await s3Client.send(
        new CopyObjectCommand({
          Bucket: bucket,
          CopySource: `${bucket}/${tempKey}`,
          Key: ptfKey,
          ContentType: "application/zip",
        })
      );
      await deletes3file(tempKey);
    } else {
      // Merge tempKey and extraFiles into ptfKey
      await mergeExtraZipFilesIntoOriginal(ptfKey, tempKey, extraFiles);
    }
    await putFile(statusFile, "-1");
    return { start: -1, extraFiles: [] };
  } else {
    await putFile(statusFile, start.toString() + " media ");
    return { start: start, extraFiles: extraFiles };
  }
}

/* ───────────────────────── HANDLER ───────────────────────── */

export const handler = async (event, context) => {
    // CATCH ALL UNHANDLED PROMISES - prevents Lambda crash
    const rejectionHandler = (reason, promise) => {
      console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    };
    process.on('unhandledRejection', rejectionHandler);
  try {
    const { body, attributes } = event.Records[0];
    const info = JSON.parse(body);
    console.log("info", info);
    const result = await exportProjectMedia(info, context);

    if (result && result.start > 0) {
      await sqsClient.send(
        new SendMessageCommand({
          QueueUrl: queue,
          MessageBody: JSON.stringify({
            ...info,
            Start: result.start,
            ExtraFiles: result.extraFiles ? result.extraFiles.join(";") : "",
          }),
          MessageGroupId: attributes.MessageGroupId,
          MessageDeduplicationId:
            attributes.MessageGroupId + "_" + result.start,
        })
      );
    }
  } catch (err) {
    console.error("Handler error:", err);
    throw err;
  }
  finally {
    process.removeListener('unhandledRejection', rejectionHandler);
  }
};
