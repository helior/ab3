import { DynamoDB } from 'aws-sdk';

const dynamodb = new DynamoDB.DocumentClient();
const TABLE_NAME = process.env.TABLE_NAME;
const GSI_NAME = process.env.GSI_NAME;

exports.handler = async (event) => {
  console.log(event);
  try {
    const ownerId = event.pathParameters?.ownerId;

    if (!ownerId) {
      return {
        statusCode: 400,
        body: JSON.stringify({ message: 'ownerId is required' }),
      };
    }

    const params = {
      TableName: TABLE_NAME,
      IndexName: GSI_NAME,
      KeyConditionExpression: 'ownerId = :ownerId',
      ExpressionAttributeValues: {
        ':ownerId': ownerId,
      },
    };

    const result = await dynamodb.query(params).promise();

    return {
      statusCode: 200,
      body: JSON.stringify(result.Items),
    };
  } catch (error) {
    console.error('Error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ message: 'Internal server error' }),
    };
  }
};

// interface ImageRecord {
//   s3ObjectKey: string;
//   ownerId: string;
//   businessUnit: 'adult' | 'kids';
//   status: 'initialized' | 'uploaded' | 'complete';
// }
