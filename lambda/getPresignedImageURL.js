import { S3 } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { GetObjectCommand } from '@aws-sdk/client-s3';

const apDomain = `https://${process.env.OLAP_ALIAS}.s3.us-east-1.amazonaws.com`;
const s3 = new S3({
  useObjectLambdaEndpoint: true,
  // endpoint: 'https://s3-object-lambda.us-east-1.amazonaws.com',
  // endpoint: apDomain,
  // region: 'us-east-1',
  // useArnRegion: true,
  // forcePathStyle: true,
  // forcePathStyle: false,
});

export const handler = async (event) => {
  try {
    const objectKey = event.pathParameters.S3ObjectKey;

    if (!objectKey) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Missing object key parameter' })
      };
    }

    // Create the GetObject command for the Object Lambda Access Point
    const command = new GetObjectCommand({
      Bucket: process.env.OLAP_ALIAS,
      Key: objectKey,
    });

    console.log('Generating presigned URL for:', {
      bucket: process.env.OLAP_ALIAS,
      key: objectKey,
      clientConfig: JSON.stringify(s3.config)
    });

    // Generate presigned URL (default expiration is 15 minutes)
    const presignedUrl = await getSignedUrl(s3, command, {
      expiresIn: 900,
      // signableHeaders: new Set(['host'])
    });

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*', // Configure as needed
      },
      body: JSON.stringify({
        presignedUrl,
        expiresIn: 900,
        debug: {
          bucket: command.input.Bucket,
          key: objectKey,
          clientConfig: s3.config
          // endpoint: apDomain,
        }
      })
    };
  } catch (error) {
    console.error('Error generating presigned URL:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Failed to generate presigned URL' })
    };
  }
};
