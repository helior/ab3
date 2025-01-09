// import { S3 } from '@aws-sdk/client-s3';
// import { GetObjectCommand } from '@aws-sdk/client-s3';
// import { S3ObjectLambdaClient, WriteGetObjectResponseCommand } from '@aws-sdk/client-s3-object-lambda';
import { S3, GetObjectCommand, WriteGetObjectResponseCommand } from '@aws-sdk/client-s3';
import { Readable } from 'stream';
import sharp from 'sharp';

const s3 = new S3();
// const s3ObjectLambda = new S3ObjectLambdaClient();

exports.handler = async (event) => {
  console.log('Dynamic S3 Get Event:', JSON.stringify(event, null, 2));
  const { getObjectContext } = event;
  const { outputRoute, outputToken, inputS3Url } = getObjectContext;

  try {
    // Get the original object from S3
    const originalObject = await s3.send(new GetObjectCommand({
      Bucket: process.env.BUCKET_NAME,
      Key: event.userRequest.url.split('/').pop()
    }));

    console.log('Retrieved original object:', {
      contentType: originalObject.ContentType,
      contentLength: originalObject.ContentLength
    });

    // Convert the readable stream to a buffer
    let bodyContents;
    if (originalObject.Body instanceof Readable) {
      bodyContents = Buffer.concat(await streamToBuffer(originalObject.Body));
    } else if (originalObject.Body instanceof Buffer) {
      bodyContents = originalObject.Body;
    } else {
      throw new Error('Unexpected body type');
    }

    // Write the response with custom header
    // const response = await s3ObjectLambda.send(new WriteGetObjectResponseCommand({
    const response = await s3.send(new WriteGetObjectResponseCommand({
      RequestRoute: outputRoute,
      RequestToken: outputToken,
      // Body: originalObject.Body,
      Body: bodyContents,
      Metadata: originalObject.Metadata,
      ContentType: originalObject.ContentType,
      ContentLength: originalObject.ContentLength,
      Headers: {
        'x-custom-header': 'helly-hellz',  // Add your custom header here
        ...originalObject.Headers
      }
    }));

    console.log('Successfully wrote response');
    return response;

  } catch (error) {
    console.error('Error:', error);
    throw error;
  }
};

// Helper function to convert readable stream to buffer
async function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    stream.on('error', (err) => reject(err));
    stream.on('end', () => resolve(chunks));
  });
}
