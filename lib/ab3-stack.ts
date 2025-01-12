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
import * as s3objectlambda from 'aws-cdk-lib/aws-s3objectlambda';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import { BucketEncryption } from 'aws-cdk-lib/aws-s3';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Runtime } from 'aws-cdk-lib/aws-lambda';
import { join } from 'path';
import * as path from 'path';

export class Ab3Stack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    /**
     * Arguments
     */
    const env = cdk.Stack.of(this).node.tryGetContext('env') ?? 'default';
    const expires = cdk.Stack.of(this).node.tryGetContext('urlExpiry') ?? '300';
    const timeout = Number(cdk.Stack.of(this).node.tryGetContext('functionTimeout') ?? '3');
    const whitelistedIps = cdk.Stack.of(this).node.tryGetContext('whitelistip').split(',')


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

    // Access point for original S3
    const s3AccessPoint = new s3.CfnAccessPoint(this, 'OriginalS3BucketAP', {
      bucket: originalS3Bucket.bucketName,
      name: 'original-ap',
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



    /**************************************************************************
     * Multi-part Upload lambdas
     */
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

    /**************************************************************************
     * Application endpoints
     */
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


    /**************************************************************************
     * Step-function invocation/lambda tasks
     */
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

    originalS3Bucket.addEventNotification(
      // Note: If I use OBJECT_CREATED event, will cause an infinite loop because new versions are PUT in the workflow
      s3.EventType.OBJECT_CREATED_COMPLETE_MULTIPART_UPLOAD,
      new s3n.LambdaDestination(initializeProcessingLambda)
    )


    // Initialize Multi-part upload
    const countModerationLabelsLambda = new NodejsFunction(this, 'countModerationLabelsHandler', {
      runtime: Runtime.NODEJS_18_X,
      entry: join(__dirname, '../lambda/countModerationLabels.js'),
      functionName: `count-moderation-labels-${env}`
    });

    const reasonableResizeLambda = new NodejsFunction(this, 'ReasonableResizeHandler', {
      runtime: Runtime.NODEJS_18_X,
      entry: join(__dirname, '../lambda/reasonable-resize/index.js'),
      functionName: `reasonable-resize-${env}`,
      memorySize: 1024,
      timeout: cdk.Duration.seconds(30),
      environment: {
        BUCKET_NAME: originalS3Bucket.bucketName,
      },
      // Note: Required for compiling platform-specific binary dependencies (Sharp)
      bundling: {
        externalModules: ['sharp'],
        nodeModules: ['sharp'],
        forceDockerBundling: true,
        commandHooks: {
          beforeBundling(inputDir: string, outputDir: string): string[] {
            return [];
          },
          beforeInstall(inputDir: string, outputDir: string): string[] {
            return [];
          },
          afterBundling(inputDir: string, outputDir: string): string[] {
            return [`cd ${outputDir}`, "rm -rf node_modules/sharp && npm install --arch=x64 --platform=linux sharp"];
          },
        }
      }
    });
    originalS3Bucket.grantReadWrite(reasonableResizeLambda);

    const censorshipLambda = new NodejsFunction(this, 'CensorshipHandler', {
      runtime: Runtime.NODEJS_18_X,
      entry: join(__dirname, '../lambda/censorship/index.js'),
      functionName: `censorship-${env}`,
      memorySize: 1024,
      timeout: cdk.Duration.seconds(30),
      environment: {
        BUCKET_NAME: originalS3Bucket.bucketName,
      },
      // Note: Required for compiling platform-specific binary dependencies (Sharp)
      bundling: {
        externalModules: ['sharp'],
        nodeModules: ['sharp'],
        forceDockerBundling: true,
        commandHooks: {
          beforeBundling(inputDir: string, outputDir: string): string[] {
            return [];
          },
          beforeInstall(inputDir: string, outputDir: string): string[] {
            return [];
          },
          afterBundling(inputDir: string, outputDir: string): string[] {
            return [`cd ${outputDir}`, "rm -rf node_modules/sharp && npm install --arch=x64 --platform=linux sharp"];
          },
        }
      }
    });
    originalS3Bucket.grantReadWrite(censorshipLambda);

    const smartCropLambda = new NodejsFunction(this, 'smartCropHandler', {
      runtime: Runtime.NODEJS_18_X,
      entry: join(__dirname, '../lambda/smart-crop/index.js'),
      functionName: `smart-crop-${env}`,
      memorySize: 1024,
      timeout: cdk.Duration.seconds(30),
      environment: {
        BUCKET_NAME: originalS3Bucket.bucketName,
      },
      // Note: Required for compiling platform-specific binary dependencies (Sharp)
      bundling: {
        externalModules: ['sharp'],
        nodeModules: ['sharp'],
        forceDockerBundling: true,
        commandHooks: {
          beforeBundling(inputDir: string, outputDir: string): string[] {
            return [];
          },
          beforeInstall(inputDir: string, outputDir: string): string[] {
            return [];
          },
          afterBundling(inputDir: string, outputDir: string): string[] {
            return [`cd ${outputDir}`, "rm -rf node_modules/sharp && npm install --arch=x64 --platform=linux sharp"];
          },
        }
      }
    });
    originalS3Bucket.grantReadWrite(smartCropLambda);
    smartCropLambda.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['rekognition:DetectFaces'],
        resources: ['*'],
      })
    );









    /**************************************************************************
     * Dynamic Resizing via S3 Object Lambda
     */

    // const dynamicRequestTransformationLambda = new NodejsFunction(this, 'dynamicRequestTransformationHandler', {
    //   runtime: Runtime.NODEJS_18_X,
    //   entry: join(__dirname, '../lambda/dynamicRequestTransformation.js'),
    //   memorySize: 1024,
    //   timeout: cdk.Duration.seconds(30),
    //   functionName: `dynamic-request-transformation-${env}`,
    //   environment: {
    //     BUCKET_NAME: originalS3Bucket.bucketName,
    //   },
    // });
    // originalS3Bucket.grantRead(dynamicRequestTransformationLambda);
    // dynamicRequestTransformationLambda.addToRolePolicy(new iam.PolicyStatement({
    //   actions: ['ssm:GetParameter', 'ssm:GetParameters'],
    //   resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/image-processor/*`],
    // }));

    // Create the Lambda function using NodejsFunction
    const dynamicS3GetLambda = new NodejsFunction(this, 'DynamicS3GetHandler', {
      runtime: Runtime.NODEJS_18_X,
      entry: join(__dirname, '../lambda/dynamic-s3-get/index.js'),
      functionName: `dynamic-s3-get-${env}`,
      memorySize: 1024,
      timeout: cdk.Duration.seconds(30),
      environment: {
        BUCKET_NAME: originalS3Bucket.bucketName,
      },
      // Note: Required for compiling platform-specific binary dependencies (Sharp)
      bundling: {
        externalModules: ['sharp'],
        nodeModules: ['sharp'],
        forceDockerBundling: true,
        commandHooks: {
          beforeBundling(inputDir: string, outputDir: string): string[] {
            return [];
          },
          beforeInstall(inputDir: string, outputDir: string): string[] {
            return [];
          },
          afterBundling(inputDir: string, outputDir: string): string[] {
            return [`cd ${outputDir}`, "rm -rf node_modules/sharp && npm install --arch=x64 --platform=linux sharp"];
          },
        }
      }
    });
    originalS3Bucket.grantRead(dynamicS3GetLambda);
    dynamicS3GetLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: ['s3-object-lambda:WriteGetObjectResponse'],
      resources: ['*'],
    }));

    /**
     * S3 Object Lambda Access Point
     */
    // Dynamic Transformation
    const objectLambdaAP = new s3objectlambda.CfnAccessPoint(this, 'ImageProcessorAP', {
      name: 'image-processor-ap',
      objectLambdaConfiguration: {
        supportingAccessPoint: s3AccessPoint.attrArn,
        transformationConfigurations: [{
          actions: ['GetObject'],
          contentTransformation: {
            AwsLambda: {
              FunctionArn: dynamicS3GetLambda.functionArn,
            },
          },
        }],
      },
    });
    // Pre-signed URL for S3 Object Lambda Access Point
    const getPresignedImageURLLambda = new lambda.Function(this, 'GetPresignedImageURLHandler', {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'getPresignedImageURL.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda')),
      environment: {
        OLAP_ARN: objectLambdaAP.attrArn
      },
      functionName: `get-presigned-image-url-${env}`,
    });


    // getPresignedImageURLLambda.addToRolePolicy(new iam.PolicyStatement({
    //   actions: [
    //     's3:GetObject',
    //     'lambda:InvokeFunction',
    //     // 's3-object-lambda:GetObject',
    //     // 's3:ListBucket',
    //     // 's3-control:*'
    //   ],
    //   resources: [
    //     `${objectLambdaAP.attrArn}/*`,
    //     objectLambdaAP.attrArn,
    //     // `${originalS3Bucket.bucketArn}/*`,
    //     // originalS3Bucket.bucketArn,
    //     // `arn:aws:s3:${this.region}:${this.account}:accesspoint/*`,
    //     // `arn:aws:s3-control:${this.region}:${this.account}:accesspoint/*`
    //     ],
    // }));

    // TODO: NOT WORKING!! Grant presign function permissions for S3 and Lambda invocation
    getPresignedImageURLLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        's3:GetObject'
      ],
      resources: [`${objectLambdaAP.attrArn}/*`]
    }));

    getPresignedImageURLLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'lambda:InvokeFunction'
      ],
      resources: [dynamicS3GetLambda.functionArn]
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

    // Task: Reasonable resize, via lambda
    const resizeTask = new tasks.LambdaInvoke(this, 'Reasonably Resize', {
      lambdaFunction: reasonableResizeLambda,
      resultPath: '$.reasonableResize',
      outputPath: '$.Payload'
    });

    // Task: Censorship, via lambda
    const censorshipTask = new tasks.LambdaInvoke(this, 'Censorship', {
      lambdaFunction: censorshipLambda,
      resultPath: '$.censorship',
      outputPath: '$.Payload'
    });

    // Task: Smart Crop, via lambda
    const smartCropTask = new tasks.LambdaInvoke(this, 'Smart Crop', {
      lambdaFunction: smartCropLambda,
      resultPath: '$.smartCrop',
      outputPath: '$.Payload'
    });

    // Task: Count Moderation Labels, via lambda
    // Fixme: A cooler way of doing this is intrinsic functions
    const countTask = new tasks.LambdaInvoke(this, 'Count Moderation Labels', {
      lambdaFunction: countModerationLabelsLambda,
      resultPath: '$.moderationLabelsCount',
      outputPath: '$.Payload'
    });

    // Task: Update DynamoDB for initializing processing
    const updateStatusInit = new tasks.DynamoUpdateItem(this, 'Initialize Status', {
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
    // TODO: send notification for websocket?

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

    // const countModerationLabels = new tasks.EvaluateExpression(this, 'Count moderation labels', {
    //   expression: 'States.ArrayLength($.moderationResults.ModerationLabels)',
    //   resultPath: '$.moderationLabelsCount'
    // })

    // Task: Content moderation (using Rekognition)
    const detectFaces = new tasks.CallAwsService(this, 'DetectFaces', {
      service: 'rekognition',
      action: 'detectFaces',
      parameters: {
        Image: {
          S3Object: {
            Bucket: sfn.JsonPath.stringAt('$.s3.bucket'),
            Name: sfn.JsonPath.stringAt('$.s3.key'),
          },
        },
        Attributes: ['DEFAULT'],
      },
      iamResources: ['*'],
      resultPath: '$.faceResults',
    });

    // Task: Update DynamoDB with rejection
    const updateStatusRejected = new tasks.DynamoUpdateItem(this, 'UpdateStatusRejected', {
      table: imageTable,
      key: {
        s3ObjectKey: tasks.DynamoAttributeValue.fromString(sfn.JsonPath.stringAt('$.record.s3ObjectKey')),
      },
      updateExpression: 'SET #status = :status',
      expressionAttributeNames: {
        '#status': 'status',
      },
      expressionAttributeValues: {
        ':status': tasks.DynamoAttributeValue.fromString('rejected'),
      },
    });

    // Create completion status update task
    const updateStatusComplete = new tasks.DynamoUpdateItem(this, 'UpdateStatusComplete', {
      table: imageTable,
      key: {
        s3ObjectKey: tasks.DynamoAttributeValue.fromString(sfn.JsonPath.stringAt('$.record.s3ObjectKey')),
      },
      updateExpression: 'SET #status = :status',
      expressionAttributeNames: {
        '#status': 'status',
      },
      expressionAttributeValues: {
        ':status': tasks.DynamoAttributeValue.fromString('complete'),
      },
    });

    // Create choice conditions
    const kidsWithInappropriateContent = sfn.Condition.and(
      sfn.Condition.stringEquals('$.record.businessUnit', 'kids'),
      // sfn.Condition.isPresent('$.moderationResults.ModerationLabels[0]') // if any moderationLabels exist, it's inappropriate!
      sfn.Condition.numberGreaterThan('$.moderationLabelsCount', 0) // if any moderationLabels exist, it's inappropriate!
    );

    // Step Function
    const stateMachine = new sfn.StateMachine(this, 'ImageProcessingStateMachine', {
      definition: sfn.Chain
        .start(updateStatusInit)
        .next(resizeTask)
        .next(detectModerationLabels)
        .next(countTask)
        .next(new sfn.Choice(this, 'Is not kid-friendly?')
          .when(kidsWithInappropriateContent, updateStatusRejected)
          .otherwise(detectFaces
            .next(smartCropTask)
            .next(new sfn.Choice(this, 'Is inappropriate?')
              .when(sfn.Condition.numberGreaterThan('$.moderationLabelsCount', 0), censorshipTask)
              .afterwards()
            )
            .next(updateStatusComplete)
          )
        )
        // .next(detectFaces)
        // .next(smartCropTask)
        // .next(new sfn.Choice(this, 'Is inappropriate?')
          // .when(sfn.Condition.numberGreaterThan('$.moderationLabelsCount', 0), censorshipTask))
        // .next(updateStatusComplete)

    });
    stateMachine.grantStartExecution(initializeProcessingLambda);
    initializeProcessingLambda.addEnvironment('STATE_MACHINE_ARN', stateMachine.stateMachineArn);
    originalS3Bucket.grantReadWrite(stateMachine)


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
    apiGateway.root.addResource('getPresignedImageUrl').addResource('{S3ObjectKey}').addMethod('GET', new apigw.LambdaIntegration(getPresignedImageURLLambda));
    // apiGateway.root.addResource('getImage').addResource('{S3ObjectKey}').addMethod('GET', new apigw.LambdaIntegration(dynamicRequestTransformationLambda));

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


    // const distribution = new cloudfront.Distribution(this, "ImageDistribution", {
    //   defaultBehavior: {
    //     origin: new origins.HttpOrigin(apiGateway.url.split('/')[2]),
    //     allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
    //     cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
    //     originRequestPolicy: new cloudfront.OriginRequestPolicy(this, "OriginRequestPolicy", {
    //       headerBehavior: cloudfront.OriginRequestHeaderBehavior.allowList(
    //         "CloudFront-Is-Mobile-Viewer",
    //         "CloudFront-Is-Tablet-Viewer",
    //         "CloudFront-Is-Desktop-Viewer"
    //       ),
    //     }),
    //   },
    // });

    // Outputs
    new cdk.CfnOutput(this, 'ObjectLambdaAccessPointArn', {
      value: objectLambdaAP.attrArn,
      description: 'ARN of the S3 Object Lambda Access Point',
    });

    new cdk.CfnOutput(this, 'SourceBucketName', {
      value: originalS3Bucket.bucketName,
      description: 'Name of the source S3 bucket',
    });

    new cdk.CfnOutput(this, 'ApiEndpoint', {
      value: apiGateway.url,
      description: 'API Gateway endpoint URL',
    });

  }
}
