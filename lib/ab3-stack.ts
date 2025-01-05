import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam'
// import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
import * as s3objectlambda from 'aws-cdk-lib/aws-s3objectlambda';
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
     * Arguments
     */
    const env = cdk.Stack.of(this).node.tryGetContext('env') ?? 'default';
    const expires = cdk.Stack.of(this).node.tryGetContext('urlExpiry') ?? '300';
    const timeout = Number(cdk.Stack.of(this).node.tryGetContext('functionTimeout') ?? '3');
    const whitelistedIps = [cdk.Stack.of(this).node.tryGetContext('whitelistip')]


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

    // // Access point for original S3
    // const accessPoint = new s3.CfnAccessPoint(this, 'OriginalS3BucketAP', {
    //   bucket: originalS3Bucket.bucketName,
    //   name: 'original-ap',
    // });




    /**
     * CloudFront
     */
    // Create Origin Access Control
    const oac = new cloudfront.CfnOriginAccessControl(this, 'OriginAccessControl', {
      originAccessControlConfig: {
        name: 'ImageBucketOAC',
        originAccessControlOriginType: 's3',
        signingBehavior: 'always',
        signingProtocol: 'sigv4'
      }
    });
    // Create CloudFront distribution
    const distribution = new cloudfront.CfnDistribution(this, 'ImageDistribution', {
      distributionConfig: {
        enabled: true,
        defaultCacheBehavior: {
          targetOriginId: 'S3Origin',
          viewerProtocolPolicy: 'redirect-to-https',
          allowedMethods: ['GET', 'HEAD'],
          cachedMethods: ['GET', 'HEAD'],
          forwardedValues: {
            queryString: false,
            headers: [
              'CloudFront-Is-Mobile-Viewer',
              'CloudFront-Is-Tablet-Viewer',
              'CloudFront-Is-Desktop-Viewer'
            ],
            cookies: {
              forward: 'none'
            }
          },
          minTtl: 1,
          defaultTtl: 60,
          maxTtl: 300,
          compress: true,
        },
        origins: [{
          id: 'S3Origin',
          domainName: `${originalS3Bucket.bucketName}.s3.${this.region}.amazonaws.com`,
          originAccessControlId: oac.attrId,
          s3OriginConfig: {
            originAccessIdentity: '' // Required for OAC
          }
        }],
        priceClass: 'PriceClass_100',
        ipv6Enabled: true,
        webAclId: webAcl.attrArn,
      }
    });

    // Update bucket policy with explicit OAC reference
    const bucketPolicyStatement = new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['s3:GetObject'],
      principals: [new iam.ServicePrincipal('cloudfront.amazonaws.com')],
      resources: [`${originalS3Bucket.bucketArn}/*`],
      conditions: {
        StringEquals: {
          'AWS:SourceArn': `arn:aws:cloudfront::${this.account}:distribution/${distribution.attrId}`
        }
      }
    });

    originalS3Bucket.addToResourcePolicy(bucketPolicyStatement);

    // Output the CloudFront URL
    new cdk.CfnOutput(this, 'DistributionUrl', {
      value: distribution.attrDomainName,
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
    const commonNodeJsProps = {
      bundling: {
        externalModules: [
          'aws-sdk',
          '@aws-sdk/client-s3',
          '@aws-sdk/s3-request-presigner',
          'sharp'
        ],
      },
      runtime: Runtime.NODEJS_18_X,
    };

    // Initialize Multi-part upload
    const initializeLambda = new NodejsFunction(this, 'initializeHandler', {
      ...commonNodeJsProps,
      entry: join(__dirname, '../lambda/initialize.js'),
      environment: {
        BUCKET_NAME: originalS3Bucket.bucketName
      },
      functionName: `multipart-upload-initialize-${env}`
    });
    originalS3Bucket.grantReadWrite(initializeLambda);

    // Get Presigned URLs
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
    originalS3Bucket.grantReadWrite(getPreSignedUrlsLambda);

    // Get Presigned URLs for Transfer Accelerator
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
    originalS3Bucket.grantReadWrite(getPreSignedTAUrlsLambda);

    // Finalize multi-part upload
    const finalizeLambda = new NodejsFunction(this, 'finalizeHandler', {
      ...commonNodeJsProps,
      entry: join(__dirname, '../lambda/finalize.js'),
      environment: {
        BUCKET_NAME: originalS3Bucket.bucketName
      },
      functionName: `multipart-upload-finalize-${env}`
    });
    originalS3Bucket.grantReadWrite(finalizeLambda);

    // Fetch all records by Owner
    const getImagesByOwnerLambda = new NodejsFunction(this, 'getImagesByOwnerHandler', {
      ...commonNodeJsProps,
      entry: join(__dirname, '../lambda/getImagesByOwner.js'),
      environment: {
        TABLE_NAME: imageTable.tableName,
        GSI_NAME: 'ownerIdIndex'
      },
      functionName: `get-images-by-owner-${env}`
    });
    imageTable.grantReadWriteData(getImagesByOwnerLambda);  //previously grantFullAccess()

    // Fixme: initialize image preprocessing via S3 PUT event
    const initializeProcessingLambda = new NodejsFunction(this, 'initializeProcessingHandler', {
      ...commonNodeJsProps,
      entry: join(__dirname, '../lambda/initializeProcessing.js'),
      environment: {
        TABLE_NAME: imageTable.tableName,
        STATE_MACHINE_ARN: '', // set below..
      },
      functionName: `initialize-processing-${env}`
    });
    imageTable.grantReadWriteData(initializeProcessingLambda);
    // S3 Event: PUT
    originalS3Bucket.addEventNotification(
      s3.EventType.OBJECT_CREATED_PUT,
      new s3n.LambdaDestination(initializeProcessingLambda)
    );

    // const dynamicRequestTransformationLambda = new NodejsFunction(this, 'dynamicRequestTransformationHandler', {
    //   ...commonNodeJsProps,
    //   entry: join(__dirname, '../lambda/dynamicRequestTransformation.js'),
    //   memorySize: 1024,
    //   timeout: cdk.Duration.seconds(30),
    //   environment: {
    //     BUCKET_NAME: originalS3Bucket.bucketName,
    //     PARAMETER_PATH: '/image-processor/'
    //   },
    //   functionName: `dynamic-request-transformation-${env}`
    // });


    // /**
    //  * S3 Object Lambda Access Point
    //  */
    // // Dynamic Transformation
    // const objectLambdaAP = new s3objectlambda.CfnAccessPoint(this, 'ImageProcessorAP', {
    //   name: 'image-processor-ap',
    //   objectLambdaConfiguration: {
    //     supportingAccessPoint: accessPoint.attrArn,
    //     transformationConfigurations: [{
    //       actions: ['GetObject'],
    //       contentTransformation: {
    //         AwsLambda: {
    //           FunctionArn: dynamicRequestTransformationLambda.functionArn,
    //         },
    //       },
    //     }],
    //   },
    // });

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
    originalS3Bucket.grantRead(new iam.ServicePrincipal('rekognition.amazonaws.com'));

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
    stateMachine.grantStartExecution(initializeProcessingLambda);
    initializeProcessingLambda.addEnvironment('STATE_MACHINE_ARN', stateMachine.stateMachineArn);



    // dynamicRequestTransformationLambda.addToRolePolicy(new iam.PolicyStatement({
    //   actions: ['ssm:GetParameter', 'ssm:GetParameters'],
    //   resources: [
    //     `arn:aws:ssm:${this.region}:${this.account}:parameter/image-processor/*`,
    //   ],
    // }));

    /**
     * API Gateway
     */
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

  }
}
