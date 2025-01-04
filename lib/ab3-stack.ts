import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam'
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import { BucketEncryption } from 'aws-cdk-lib/aws-s3';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Runtime } from 'aws-cdk-lib/aws-lambda';
import { join } from 'path';

export class Ab3Stack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    /**
     * Setup
     */
    const env = cdk.Stack.of(this).node.tryGetContext('env') ?? 'default';
    const expires = cdk.Stack.of(this).node.tryGetContext('urlExpiry') ?? '300';
    const timeout = Number(cdk.Stack.of(this).node.tryGetContext('functionTimeout') ?? '3');
    const whitelistedIps = [cdk.Stack.of(this).node.tryGetContext('whitelistip')]

    const apiResourcePolicy = new iam.PolicyDocument({
      statements: [
        new iam.PolicyStatement({
          actions: ['execute-api:Invoke'],
          principals: [new iam.AnyPrincipal()],
          resources: ['execute-api:/*/*/*'],
        }),
        new iam.PolicyStatement({
          effect: iam.Effect.DENY,
          principals: [new iam.AnyPrincipal()],
          actions: ['execute-api:Invoke'],
          resources: ['execute-api:/*/*/*'],
          conditions: {
            'NotIpAddress': {
              "aws:SourceIp": whitelistedIps
            }
          }
        })
      ]
    })

    const commonNodeJsProps = {
      bundling: {
        externalModules: [
          'aws-sdk',
          '@aws-sdk/client-s3',
          '@aws-sdk/s3-request-presigner',
        ],
      },
      runtime: Runtime.NODEJS_18_X,
    };


/**
 * Parameter Store
 */
    new ssm.StringParameter(this, 'MobileDeviceMapping', {
      parameterName: '/image-processor/device-mappings/mobile',
      stringValue: JSON.stringify({ width: 640, height: 960 }),
    });

    new ssm.StringParameter(this, 'TabletDeviceMapping', {
      parameterName: '/image-processor/device-mappings/tablet',
      stringValue: JSON.stringify({ width: 1024, height: 1366 }),
    });

    new ssm.StringParameter(this, 'DesktopDeviceMapping', {
      parameterName: '/image-processor/device-mappings/desktop',
      stringValue: JSON.stringify({ width: 1920, height: 1080 }),
    });

    new ssm.StringParameter(this, 'TimestampConfig', {
      parameterName: '/image-processor/timestamp-config',
      stringValue: JSON.stringify({
        font: 'Arial',
        fontSize: 24,
        rgba: true,
      }),
    });

    /**
     * S3
     */
    const originalS3Bucket = new s3.Bucket(this, "original-s3-bucket", {
      bucketName: `original-${env}`,
      lifecycleRules: [{
        expiration: cdk.Duration.days(10),
        abortIncompleteMultipartUploadAfter: cdk.Duration.days(1),
      }],
    blockPublicAccess: {
        blockPublicAcls: true,
        blockPublicPolicy: true,
        ignorePublicAcls: true,
        restrictPublicBuckets: true,
      },
      encryption: BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      transferAcceleration: true,
      cors: [{
        allowedOrigins: ["*"],
        allowedHeaders: ["*"],
        allowedMethods: [
          s3.HttpMethods.GET,
          s3.HttpMethods.PUT,
          s3.HttpMethods.POST,
        ],
        exposedHeaders: ['ETag'],
      }],
      removalPolicy: cdk.RemovalPolicy.DESTROY
    });

    /**
     * Web Application Firewall
     */
    const webAcl = new wafv2.CfnWebACL(this, 'ImageCdnWebAcl', {
      defaultAction: { allow: {} },
      scope: 'CLOUDFRONT',
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: 'ImageCdnWebAclMetric',
        sampledRequestsEnabled: true,
      },
      rules: [
        {
          name: 'RateLimit',
          priority: 1,
          action: { block: {} },
          statement: {
            rateBasedStatement: {
              limit: 2000,
              aggregateKeyType: 'IP',
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: 'RateLimitRule',
            sampledRequestsEnabled: true,
          },
        },
        {
          name: 'AWSManagedRulesCommonRuleSet',
          priority: 2,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: {
              vendorName: 'AWS',
              name: 'AWSManagedRulesCommonRuleSet',
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: 'AWSManagedRulesCommonRuleSetMetric',
            sampledRequestsEnabled: true,
          },
        },
      ],
    });

    /**
     * CloudFront
     */
    // Create Origin Access Identity for CloudFront
    const oai = new cloudfront.OriginAccessIdentity(this, 'CloudFrontOAI');
    originalS3Bucket.grantRead(oai);

    // Create CloudFront distribution
    const distribution = new cloudfront.Distribution(this, 'ImageDistribution', {
      defaultBehavior: {
        origin: new origins.S3Origin(originalS3Bucket, {
          originAccessIdentity: oai,
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD,
        cachePolicy: new cloudfront.CachePolicy(this, 'ImageCachePolicy', {
          defaultTtl: cdk.Duration.minutes(1),
          minTtl: cdk.Duration.seconds(1),
          maxTtl: cdk.Duration.minutes(5),
          headerBehavior: cloudfront.CacheHeaderBehavior.allowList(
            'CloudFront-Is-Mobile-Viewer',
            'CloudFront-Is-Tablet-Viewer',
            'CloudFront-Is-Desktop-Viewer'
          ),
          enableAcceptEncodingGzip: true,
          enableAcceptEncodingBrotli: true,
        }),
        originRequestPolicy: new cloudfront.OriginRequestPolicy(this, 'DeviceAwarePolicy', {
          headerBehavior: cloudfront.OriginRequestHeaderBehavior.allowList(
            'CloudFront-Is-Mobile-Viewer',
            'CloudFront-Is-Tablet-Viewer',
            'CloudFront-Is-Desktop-Viewer'
          ),
        }),
      },
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      enableIpv6: true,
      webAclId: webAcl.attrArn,
    });

    // Output the CloudFront URL
    new cdk.CfnOutput(this, 'DistributionUrl', {
      value: `https://${distribution.distributionDomainName}`,
      description: 'CloudFront Distribution URL',
    });



    /**
     * DynamoDB
     */
    const imageTable = new dynamodb.Table(this, 'ImageTable', {
      tableName: 'Image',
      partitionKey: { name: 's3ObjectKey', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    });
    // Add GSI for querying by ownerId
    imageTable.addGlobalSecondaryIndex({
      indexName: 'ownerIdIndex',
      partitionKey: { name: 'ownerId', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });


    /**
     * Lambda
     */
    const initializeLambda = new NodejsFunction(this, 'initializeHandler', {
      ...commonNodeJsProps,
      entry: join(__dirname, '../lambda/initialize.js'),
      environment: {
        BUCKET_NAME: originalS3Bucket.bucketName
      },
      functionName: `multipart-upload-initialize-${env}`
    });

    const getPreSignedUrlsLambda = new NodejsFunction(this, 'getPreSignedUrlsHandler', {
      ...commonNodeJsProps,
      entry: join(__dirname, '../lambda/getPreSignedUrls.js'),
      environment: {
        BUCKET_NAME: originalS3Bucket.bucketName,
        URL_EXPIRES: expires
      },
      functionName: `multipart-upload-getPreSignedUrls-${env}`,
      timeout: cdk.Duration.seconds(timeout)
    });

    const getPreSignedTAUrlsLambda = new NodejsFunction(this, 'getPreSignedTAUrlsHandler', {
      ...commonNodeJsProps,
      entry: join(__dirname, '../lambda/getPreSignedTAUrls.js'),
      environment: {
        BUCKET_NAME: originalS3Bucket.bucketName,
        URL_EXPIRES: expires
      },
      functionName: `multipart-upload-getPreSignedTAUrls-${env}`,
      timeout: cdk.Duration.seconds(timeout)
    });

    const finalizeLambda = new NodejsFunction(this, 'finalizeHandler', {
      ...commonNodeJsProps,
      entry: join(__dirname, '../lambda/finalize.js'),
      environment: {
        BUCKET_NAME: originalS3Bucket.bucketName
      },
      functionName: `multipart-upload-finalize-${env}`
    });

    const getImagesByOwnerLambda = new NodejsFunction(this, 'getImagesByOwnerHandler', {
      ...commonNodeJsProps,
      entry: join(__dirname, '../lambda/getImagesByOwner.js'),
      environment: {
        TABLE_NAME: imageTable.tableName,
        GSI_NAME: 'ownerIdIndex'
      },
      functionName: `get-images-by-owner-${env}`
    });

    const initializeProcessingLambda = new NodejsFunction(this, 'initializeProcessingHandler', {
      ...commonNodeJsProps,
      entry: join(__dirname, '../lambda/initializeProcessing.js'),
      environment: {
        TABLE_NAME: imageTable.tableName,
        STATE_MACHINE_ARN: '', // set below..
      },
      functionName: `initialize-processing-${env}`
    });


    /**
     * Step-Function / tasks
     */
    // Task: Update DynamoDB for initializing processing
    const updateStatusInit = new tasks.DynamoUpdateItem(this, 'UpdateStatusInit', {
      table: imageTable,
      key: {
        s3ObjectKey: tasks.DynamoAttributeValue.fromString(sfn.JsonPath.stringAt('$.record.s3ObjectKey')),
      },
      updateExpression: 'SET #status = :status',
      expressionAttributeNames: {
        '#status': 'status',
      },
      expressionAttributeValues: {
        ':status': tasks.DynamoAttributeValue.fromString('init processing'),
      },
    });

    // Task: Content moderation (using Rekognition)
    const detectModerationLabels = new tasks.CallAwsService(this, 'DetectModerationLabels', {
      service: 'rekognition',
      action: 'detectModerationLabels',
      parameters: {
        Image: {
          S3Object: {
            Bucket: sfn.JsonPath.stringAt('$.s3.bucket'),
            Name: sfn.JsonPath.stringAt('$.s3.key'),
          },
        },
        MinConfidence: 50,
      },
      iamResources: ['*'],
      resultPath: '$.moderationResults',
    });

    // Task: Update DynamoDB with rejection
    const updateStatusRejected = new tasks.DynamoUpdateItem(this, 'UpdateStatusRejected', {
      table: imageTable,
      key: {
        s3ObjectKey: tasks.DynamoAttributeValue.fromString(sfn.JsonPath.stringAt('$.record.s3ObjectKey')),
      },
      updateExpression: 'SET #status = :status, #results = :results',
      expressionAttributeNames: {
        '#status': 'status',
        '#results': 'moderationResults',
      },
      expressionAttributeValues: {
        ':status': tasks.DynamoAttributeValue.fromString('rejected'),
        ':results': tasks.DynamoAttributeValue.fromString(sfn.JsonPath.stringAt('$.moderationResults')),
      },
    });

    // Create completion status update task
    const updateStatusComplete = new tasks.DynamoUpdateItem(this, 'UpdateStatusComplete', {
      table: imageTable,
      key: {
        s3ObjectKey: tasks.DynamoAttributeValue.fromString(sfn.JsonPath.stringAt('$.record.s3ObjectKey')),
      },
      updateExpression: 'SET #status = :status, #results = :results',
      expressionAttributeNames: {
        '#status': 'status',
        '#results': 'moderationResults',
      },
      expressionAttributeValues: {
        ':status': tasks.DynamoAttributeValue.fromString('complete'),
        ':results': tasks.DynamoAttributeValue.fromString(sfn.JsonPath.stringAt('$.moderationResults')),
      },
    });

    // Create choice conditions
    const shouldReject = sfn.Condition.and(
      sfn.Condition.stringEquals('$.record.businessUnit', 'kids'),
      sfn.Condition.numberGreaterThan('$.moderationResults.ModerationLabels', 0)
    );

    // Create choice state
    const moderationChoice = new sfn.Choice(this, 'EvaluateModeration')
      .when(shouldReject, updateStatusRejected)
      .otherwise(updateStatusComplete);

      // Step Function
    const stateMachine = new sfn.StateMachine(this, 'ImageProcessingStateMachine', {
      definition: sfn.Chain
        .start(updateStatusInit)
        .next(detectModerationLabels)
        .next(moderationChoice),
    });

    initializeProcessingLambda.addEnvironment('STATE_MACHINE_ARN', stateMachine.stateMachineArn);

    /**
     * Grant access
     */
    originalS3Bucket.grantReadWrite(initializeLambda);
    originalS3Bucket.grantReadWrite(getPreSignedUrlsLambda);
    originalS3Bucket.grantReadWrite(getPreSignedTAUrlsLambda);
    originalS3Bucket.grantReadWrite(finalizeLambda);
    imageTable.grantReadWriteData(getImagesByOwnerLambda);  //previously grantFullAccess()
    imageTable.grantReadWriteData(initializeProcessingLambda);
    stateMachine.grantStartExecution(initializeProcessingLambda);

    /**
     * API Gateway
     */
    const apiGateway = new apigw.RestApi(this, 'image-processing', {
      description: 'API for image processing',
      restApiName: 'image-processing',
      defaultCorsPreflightOptions: {
        allowOrigins: apigw.Cors.ALL_ORIGINS,
      },
      policy: apiResourcePolicy,
    });

    apiGateway.root.addResource('initialize').addMethod('POST', new apigw.LambdaIntegration(initializeLambda));
    apiGateway.root.addResource('getPreSignedUrls').addMethod('POST', new apigw.LambdaIntegration(getPreSignedUrlsLambda));
    apiGateway.root.addResource('getPreSignedTAUrls').addMethod('POST', new apigw.LambdaIntegration(getPreSignedTAUrlsLambda));
    apiGateway.root.addResource('finalize').addMethod('POST', new apigw.LambdaIntegration(finalizeLambda));
    apiGateway.root.addResource('images').addResource('{ownerId}').addMethod('GET', new apigw.LambdaIntegration(getImagesByOwnerLambda));

    apiGateway.addUsagePlan('usage-plan', {
      name: 'consumerA-multi-part-upload-plan',
      description: 'usage plan for consumerA',
      apiStages: [{
        api: apiGateway,
        stage: apiGateway.deploymentStage,
      }],
      throttle: {
        rateLimit: 100,
        burstLimit: 200
      },
    });


    /**
     * S3 Event Trigger
     */
    originalS3Bucket.addEventNotification(
      s3.EventType.OBJECT_CREATED_PUT,
      new s3n.LambdaDestination(initializeProcessingLambda)
    );

    // Grant S3 read permissions to Rekognition
    originalS3Bucket.grantRead(new iam.ServicePrincipal('rekognition.amazonaws.com'));
  }
}
