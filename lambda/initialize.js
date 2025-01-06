import { S3Client, CreateMultipartUploadCommand} from '@aws-sdk/client-s3';

const AWS = require('aws-sdk');
const dynamodb = new AWS.DynamoDB.DocumentClient();
// const { v4: uuidv4 } = require('uuid');
const BUCKET_NAME = process.env['BUCKET_NAME'];

const s3 = new S3Client();

exports.handler = async (event) => {
	console.log(event);
	if (!event.body) {
		throw new Error("event.body is not defined");
	}
	const body = JSON.parse(event.body);

	if (!body.name) {
		throw new Error("name of the file is required");
	}
	if (!body.ownerId) {
		throw new Error("ownerId of the file is required");
	}
	if (!body.businessUnit) {
		throw new Error("businessUnit of the file is required");
	}

	try {
		const params = {
			TableName: 'Image',
			Item: {
				s3ObjectKey: body.name,
				ownerId: body.ownerId,
				businessUnit: body.businessUnit,
				status: 'initialized',
				createdOn: new Date().toISOString(),
			}
		}

		await dynamodb.put(params).promise();

	} catch (error) {
		console.error('Error:', error);
		return {
			statusCode: 500,
			body: JSON.stringify({
				message: 'Error saving record',
				error: error.message
			})
		};
	}

	const multipartParams = {
		Bucket: BUCKET_NAME,
		Key: body.name,
	}
	const command = new CreateMultipartUploadCommand(multipartParams);
	const multipartUpload = await s3.send(command);

	return {
		statusCode: 200,
		body: JSON.stringify({
			fileId: multipartUpload.UploadId,
			fileKey: multipartUpload.Key,
		}),
		headers: {
			'Access-Control-Allow-Origin': '*'
		}
	};
}

// {
// 	"s3ObjectKey": "to-be-s3-key-of-object-plus-random-uid",
// 	"ownerId": "12345",
// 	"businessUnit": "adult",
// 	"status": "initialized",
//	"createdOn": "2024-09-17-15:00:00"
// }
