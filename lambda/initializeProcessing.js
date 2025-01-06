import { DynamoDB, StepFunctions } from 'aws-sdk';

const dynamodb = new DynamoDB.DocumentClient();
const stepFunctions = new StepFunctions();

const TABLE_NAME = process.env.TABLE_NAME;
const STATE_MACHINE_ARN = process.env.STATE_MACHINE_ARN;

exports.handler = async (event) => {
  try {
    for (const record of event.Records) {
      const s3ObjectKey = decodeURIComponent(record.s3.object.key.replace(/\+/g, ' '));
      const bucketName = record.s3.bucket.name;

      // Get record from DynamoDB
      const getParams = {
        TableName: TABLE_NAME,
        Key: {
          s3ObjectKey: s3ObjectKey,
        },
      };

      const result = await dynamodb.get(getParams).promise();
      const item = result.Item;

      if (!item) {
        console.error(`No DynamoDB record found for key: ${s3ObjectKey}`);
        continue;
      }

      // Start Step Function execution with S3 details in context
      const params = {
        stateMachineArn: STATE_MACHINE_ARN,
        input: JSON.stringify({
          s3: {
            bucket: bucketName,
            key: s3ObjectKey
          },
          record: {
            s3ObjectKey: s3ObjectKey,
            ownerId: item.ownerId,
            businessUnit: item.businessUnit,
            status: item.status
          }
        }),
      };

      await stepFunctions.startExecution(params).promise();
      console.log(`Started Step Function execution for: ${s3ObjectKey}`);
    }
  } catch (error) {
    console.error('Error processing S3 event:', error);
    throw error;
  }
};
