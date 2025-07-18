# Welcome to your CDK TypeScript project
👋🏼
```sh
# invoke initialize lambda to for imageUploadID
curl -X POST https://1cbh6il1lh.execute-api.us-east-1.amazonaws.com/prod/initialize \
-H "Content-Type: application/json" \
-d '{"name": "helior.txt"}'

# Retrieve image from apigw/lambda/s3
curl -X GET 'https://1cbh6il1lh.execute-api.us-east-1.amazonaws.com/prod/getImage/slam.png' -H 'cloudfront-is-mobile-viewer: true'

# Get presigned URL for an image to access S3 Object Lambda
curl -X GET 'https://1cbh6il1lh.execute-api.us-east-1.amazonaws.com/prod/getPresignedImageUrl/slam.png'

# Images by ownerId
curl -X GET 'https://1cbh6il1lh.execute-api.us-east-1.amazonaws.com/prod/images/1'

# Deploy via CDK
cdk deploy --context env="one" --context urlExpiry="900" --context whitelistip="76.33.137.141,173.196.171.194,205.251.233.182,54.183.107.205"

# Destroy
cdk destroy

# Copy from bucket
aws s3 cp s3://image-processor-ap-1qnajnu11hzp81rsryt95xw4use1a--ol-s3/slam.png ./localslam.png

# Generate Presigned URL for Object Lambda Access Point
aws s3 presign s3://image-processor-ap-1qnajnu11hzp81rsryt95xw4use1a--ol-s3/slam.png --expires=60


# Deploy lambda functions faster
export FILE="lambda/dynamic-s3-get/" && export FUNC="dynamic-s3-get-one" && zip -rj function.zip $FILE && aws lambda update-function-code --region 'us-east-1' --function-name $FUNC --zip-file fileb://function.zip
```
---
#### Outputs
https://d1lm51n3xl8g8m.cloudfront.net
https://ddzaqzc858s33.cloudfront.net
---
