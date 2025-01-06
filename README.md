# Welcome to your CDK TypeScript project
👋🏼 
```sh
# invoke initialize lambda to for imageUploadID
curl -X POST https://1cbh6il1lh.execute-api.us-east-1.amazonaws.com/prod/initialize \
-H "Content-Type: application/json" \
-d '{"name": "helior.txt"}'

# Retrieve image from apigw/lambda/s3
curl -X GET 'https://1cbh6il1lh.execute-api.us-east-1.amazonaws.com/prod/getImage/slam.png' -H 'cloudfront-is-mobile-viewer: true'

# Images by ownerId
curl -X GET 'https://1cbh6il1lh.execute-api.us-east-1.amazonaws.com/prod/images/1'

# Deploy via CDK
cdk deploy --context env="one" --context urlExpiry="900" --context whitelistip="76.33.137.141"

# Destroy
cdk destroy
```
---
#### Outputs
https://d1lm51n3xl8g8m.cloudfront.net
https://ddzaqzc858s33.cloudfront.net

---
This is a blank project for CDK development with TypeScript.

The `cdk.json` file tells the CDK Toolkit how to execute your app.

## Useful commands

* `npm run build`   compile typescript to js
* `npm run watch`   watch for changes and compile
* `npm run test`    perform the jest unit tests
* `npx cdk deploy`  deploy this stack to your default AWS account/region
* `npx cdk diff`    compare deployed stack with current state
* `npx cdk synth`   emits the synthesized CloudFormation template

cdk deploy --context env="one" --context whitelistip="76.33.137.141"
