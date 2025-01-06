import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam'
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
// import * as s3objectlambda from 'aws-cdk-lib/aws-s3objectlambda';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import { BucketEncryption } from 'aws-cdk-lib/aws-s3';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Runtime } from 'aws-cdk-lib/aws-lambda';
import { join } from 'path';
import * as path from 'path';
// import { experimental } from 'aws-cdk-lib/aws-cloudfront';

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
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      versioned: true
    });


    // // Add Lambda@Edge permissions
    // const edgeRole = new iam.Role(this, 'EdgeRole', {
    //   assumedBy: new iam.CompositePrincipal(
    //     new iam.ServicePrincipal('lambda.amazonaws.com'),
    //     new iam.ServicePrincipal('edgelambda.amazonaws.com')
    //   ),
    //   managedPolicies: [
    //     iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')
    //   ],
    //   inlinePolicies: {
    //     'EdgeLogging': new iam.PolicyDocument({
    //       statements: [
    //         new iam.PolicyStatement({
    //           effect: iam.Effect.ALLOW,
    //           actions: [
    //             'logs:CreateLogGroup',
    //             'logs:CreateLogStream',
    //             'logs:PutLogEvents'
    //           ],
    //           resources: ['arn:aws:logs:*:*:*']
    //         })
    //       ]
    //     })
    //   }
    // });

    // // Allows reading from S3 and writing logs, etc.
    // const lambdaEdgeRole = new iam.Role(this, 'LambdaEdgeRole', {
    //   assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    //   description: 'Role used by the Lambda@Edge function to read from S3 and write logs.',
    // });

    // // Attach the basic execution role (for CloudWatch Logs)
    // lambdaEdgeRole.addManagedPolicy(
    //   iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
    // );

    // // Add permission to read objects from our bucket
    // lambdaEdgeRole.addToPolicy(
    //   new iam.PolicyStatement({
    //     actions: ['s3:GetObject'],
    //     resources: [originalS3Bucket.bucketArn + '/*'],
    //   }),
    // );

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
    // const commonNodeJsProps = {
    //   bundling: {
    //     externalModules: [
    //       // 'aws-sdk',
    //       // '@aws-sdk/client-s3',
    //       // '@aws-sdk/s3-request-presigner',
    //       // 'sharp',
    //       // 'uuid'
    //     ],
    //   },
    //   runtime: Runtime.NODEJS_18_X,
    // };

    // Initialize Multi-part upload
    const initializeLambda = new NodejsFunction(this, 'initializeHandler', {
      runtime: Runtime.NODEJS_18_X,
      entry: join(__dirname, '../lambda/initialize.js'),
      environment: {
        BUCKET_NAME: originalS3Bucket.bucketName
      },
      functionName: `multipart-upload-initialize-${env}`
    });
    originalS3Bucket.grantReadWrite(initializeLambda);
    imageTable.grantReadWriteData(initializeLambda);

    // Get Presigned URLs
    const getPreSignedUrlsLambda = new NodejsFunction(this, 'getPreSignedUrlsHandler', {
      runtime: Runtime.NODEJS_18_X,
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
      runtime: Runtime.NODEJS_18_X,
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
      runtime: Runtime.NODEJS_18_X,
      entry: join(__dirname, '../lambda/finalize.js'),
      environment: {
        BUCKET_NAME: originalS3Bucket.bucketName
      },
      functionName: `multipart-upload-finalize-${env}`
    });
    originalS3Bucket.grantReadWrite(finalizeLambda);

    // Fetch all records by Owner
    const getImagesByOwnerLambda = new NodejsFunction(this, 'getImagesByOwnerHandler', {
      runtime: Runtime.NODEJS_18_X,
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
      runtime: Runtime.NODEJS_18_X,
      entry: join(__dirname, '../lambda/initializeProcessing.js'),
      environment: {
        TABLE_NAME: imageTable.tableName,
        STATE_MACHINE_ARN: '', // set below..
      },
      functionName: `initialize-processing-${env}`
    });
    imageTable.grantReadWriteData(initializeProcessingLambda);
    // S3 Event: s3:ObjectCreated:*
    originalS3Bucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.LambdaDestination(initializeProcessingLambda)
    )

    // const sharpLayer = new lambda.LayerVersion(this, "SharpLayer", {
    //   code: lambda.Code.fromAsset(path.join(__dirname, "../layers")),
    //   compatibleRuntimes: [lambda.Runtime.NODEJS_18_X],
    //   description: "A layer that includes the sharp library",
    // });

    const dynamicRequestTransformationLambda = new NodejsFunction(this, 'dynamicRequestTransformationHandler', {

      // bundling: {
      //   externalModules: ['sharp'],
      //   nodeModules: ['sharp'],
      //   commandHooks: {
      //     beforeBundling(inputDir: string, outputDir: string): string[] {
      //       return [];
      //     },
      //     beforeInstall(inputDir: string, outputDir: string): string[] {
      //       return [];
      //     },
      //     afterBundling(inputDir: string, outputDir: string): string[] {
      //       return [`cd ${outputDir}`, "rm -rf node_modules/sharp && npm install --cpu=x64 --os=linux sharp"];
      //     },
      //   },
      // },

      // bundling: {
      //   command: [
      //     'bash', '-c',
      //     'npm install && ' +
      //     'npm install --cpu=x64 --os=linux sharp && ' +
      //     'cp -r /asset-input/* /asset-output/'
      //   ],
      // },

      runtime: Runtime.NODEJS_18_X,
      entry: join(__dirname, '../lambda/dynamicRequestTransformation.js'),
      memorySize: 1024,
      timeout: cdk.Duration.seconds(30),
      functionName: `dynamic-request-transformation-${env}`,
      environment: {
        BUCKET_NAME: originalS3Bucket.bucketName,
      },
      // layers: [sharpLayer]
    });

    originalS3Bucket.grantRead(dynamicRequestTransformationLambda);
    dynamicRequestTransformationLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter', 'ssm:GetParameters'],
      resources: [
        `arn:aws:ssm:${this.region}:${this.account}:parameter/image-processor/*`,
      ],
    }));

    // const dynamicRequestTransformationLambda = new NodejsFunction(this, 'dynamicRequestTransformationHandler', {
    //   ...commonNodeJsProps,
    //   entry: join(__dirname, '../lambda/dynamicRequestTransformation.js'),
    //   memorySize: 1024,
    //   timeout: cdk.Duration.seconds(30),
    //   functionName: `dynamic-request-transformation-${env}`,
    //   role: edgeRole
    // });

    // const imageProcessingEdgeFunction = new experimental.EdgeFunction(this, 'ImageProcessingEdgeFunction', {
    //   runtime: cdk.aws_lambda.Runtime.NODEJS_18_X, // or any supported runtime for Lambda@Edge
    //   // entry: join(__dirname, '../lambda/edge-image-processor.js'),
    //   code: cdk.aws_lambda.Code.fromAsset(path.join(__dirname, '../lambda')), // e.g. folder containing "edge-image-processor.js"
    //   handler: 'edge-image-processor.handler', // match the exported function name in the ES module
    //   role: lambdaEdgeRole,
    //   description: 'Resizes and watermarks images using CloudFront device detection headers and current timestamp.',
    // });

        /**
     * CloudFront
     */
    // // Create Origin Access Control
    // const oac = new cloudfront.CfnOriginAccessControl(this, 'OriginAccessControl', {
    //   originAccessControlConfig: {
    //     name: 'ImageBucketOAC',
    //     originAccessControlOriginType: 's3',
    //     signingBehavior: 'always',
    //     signingProtocol: 'sigv4'
    //   }
    // });

    // // Create Origin Access Identity
    // const oai = new cloudfront.CfnCloudFrontOriginAccessIdentity(
    //   this,
    //   'OAI',
    //   {
    //     cloudFrontOriginAccessIdentityConfig: {
    //       comment: 'OAI for image distribution'
    //     }
    //   }
    // );


    // // Create CloudFront distribution
    // const distribution = new cloudfront.CfnDistribution(this, 'ImageDistribution', {
    //   distributionConfig: {
    //     enabled: true,
    //     defaultCacheBehavior: {
    //       targetOriginId: 'S3Origin',
    //       viewerProtocolPolicy: 'redirect-to-https',
    //       allowedMethods: ['GET', 'HEAD'],
    //       cachedMethods: ['GET', 'HEAD'],
    //       forwardedValues: {
    //         queryString: false,
    //         headers: [
    //           'CloudFront-Is-Mobile-Viewer',
    //           'CloudFront-Is-Tablet-Viewer',
    //           'CloudFront-Is-Desktop-Viewer',
    //           'CloudFront-Is-SmartTV-Viewer'
    //         ],
    //         cookies: {forward: 'none'}
    //       },
    //       minTtl: 1,
    //       defaultTtl: 60,
    //       maxTtl: 300,
    //       compress: true,
    //       lambdaFunctionAssociations: [{
    //         eventType: 'origin-response',
    //         lambdaFunctionArn: `${dynamicRequestTransformationLambda.functionArn}:${dynamicRequestTransformationLambda.currentVersion.version}`
    //       }]
    //     },
    //     origins: [{
    //       id: 'S3Origin',
    //       domainName: originalS3Bucket.bucketRegionalDomainName,
    //       s3OriginConfig: {
    //         originAccessIdentity: oai.ref
    //       }
    //     }],
    //     priceClass: 'PriceClass_100',
    //     ipv6Enabled: true,
    //     webAclId: webAcl.attrArn,
    //   }
    // });

    // const distribution = new cloudfront.Distribution(this, 'ImageDistribution', {
    //   defaultBehavior: {
    //     origin: new origins.S3Origin(originalS3Bucket),
    //     cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED, // or a custom cache policy
    //     // For device detection, ensure these headers are included:
    //     viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
    //     edgeLambdas: [
    //       {
    //         functionVersion: imageProcessingEdgeFunction.currentVersion,
    //         eventType: cloudfront.LambdaEdgeEventType.ORIGIN_REQUEST,
    //         // OR cloudfront.LambdaEdgeEventType.VIEWER_RESPONSE
    //         // If you want to handle device detection at 'viewer' level, you might choose VIEWER_RESPONSE
    //         includeBody: true,  // We need the image body to process it
    //       },
    //     ],
    //   },
    //   additionalBehaviors: {
    //     // If you want specific paths (like /images/*) to apply the function, you could define behaviors here
    //   },
    // });

    // new cdk.CfnOutput(this, 'CloudFrontDomain', {
    //   value: distribution.distributionDomainName,
    //   description: 'Domain name of the CloudFront distribution',
    // });


    // // Update bucket policy with explicit OAC reference
    // const bucketPolicyStatement = new iam.PolicyStatement({
    //   // effect: iam.Effect.ALLOW,
    //   // actions: ['s3:GetObject'],
    //   // principals: [new iam.ServicePrincipal('cloudfront.amazonaws.com')],
    //   // resources: [`${originalS3Bucket.bucketArn}/*`],
    //   // conditions: {
    //   //   StringEquals: {
    //   //     'AWS:SourceArn': `arn:aws:cloudfront::${this.account}:distribution/${distribution.attrId}`
    //   //   }
    //   // }
    //   actions: ['s3:GetObject'],
    //   resources: [originalS3Bucket.arnForObjects('*')],
    //   principals: [
    //     new iam.CanonicalUserPrincipal(oai.getAtt('S3CanonicalUserId').toString())
    //   ]
    // });
    // originalS3Bucket.addToResourcePolicy(bucketPolicyStatement);

    // // Output the CloudFront URL
    // new cdk.CfnOutput(this, 'DistributionUrl', {
    //   value: distribution.attrDomainName,
    //   description: 'CloudFront Distribution URL',
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
      resultPath: '$.recordMeta'
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
    const kidsWithInappropriateContent = sfn.Condition.and(
      sfn.Condition.stringEquals('$.record.businessUnit', 'kids'),
      sfn.Condition.numberGreaterThan('$.moderationResults.ModerationLabels', 0)
    );

    // Step Function
    const stateMachine = new sfn.StateMachine(this, 'ImageProcessingStateMachine', {
      definition: sfn.Chain
        .start(updateStatusInit)
        .next(detectModerationLabels)
        .next(new sfn.Choice(this, 'EvaluateModeration')
          .when(kidsWithInappropriateContent, updateStatusRejected)
          .otherwise(updateStatusComplete)),
    });
    stateMachine.grantStartExecution(initializeProcessingLambda);
    initializeProcessingLambda.addEnvironment('STATE_MACHINE_ARN', stateMachine.stateMachineArn);



    // dynamicRequestTransformationLambda.addToRolePolicy(new iam.PolicyStatement({
    //   actions: ['ssm:GetParameter', 'ssm:GetParameters'],
    //   resources: [
    //     `arn:aws:ssm:${this.region}:${this.account}:parameter/image-processor/*`,
    //   ],
    // }));
    // dynamicRequestTransformationLambda.role?.addToPrincipalPolicy(
    //   new iam.PolicyStatement({
    //     actions: ['ssm:GetParameters'],
    //     resources: [
    //       `arn:aws:ssm:${this.region}:${this.account}:parameter/image-processor/*`
    //     ]
    //   })
    // );

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
    apiGateway.root.addResource('getImage').addResource('{S3ObjectKey}').addMethod('GET', new apigw.LambdaIntegration(dynamicRequestTransformationLambda));

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


    const distribution = new cloudfront.Distribution(this, "ImageDistribution", {
      defaultBehavior: {
        origin: new origins.HttpOrigin(apiGateway.url.split('/')[2]),
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        originRequestPolicy: new cloudfront.OriginRequestPolicy(this, "OriginRequestPolicy", {
          headerBehavior: cloudfront.OriginRequestHeaderBehavior.allowList(
            "CloudFront-Is-Mobile-Viewer",
            "CloudFront-Is-Tablet-Viewer",
            "CloudFront-Is-Desktop-Viewer"
          ),
        }),
      },
    });

  }
}
