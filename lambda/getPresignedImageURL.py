import json
import boto3
from botocore.config import Config
import os

s3 = boto3.client('s3', config=Config(signature_version='s3v4'))

def handler(event, context):
  bucket = os.environ.get('OLAP_ARN')
  key = event["pathParameters"]["S3ObjectKey"]

  if (not key):
    return {
      "statusCode": 400,
      "body": "Missing S3ObjectKey path parameter"
    }

  response = s3.generate_presigned_url(
    'get_object',
    Params={
      'Bucket': bucket,
      'Key': key
    }
  )

  # return {
  #     "statusCode": 200,
  #     "headers": {
  #         "Content-Type": "application/json"
  #     },
  #     "body": json.dumps({
  #         "url": response,
  #         "key": key,
  #         "bucket": bucket
  #     }),
  # }

  return {
     "statusCode": 200,
     "body": response
  }
