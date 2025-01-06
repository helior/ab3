// lambda/image-processor/index.js
const AWS = require('aws-sdk');
const Sharp = require('sharp');

const s3 = new AWS.S3();
// const ssm = new AWS.SSM();

// Default configurations
const DEFAULT_CONFIG = {
  deviceMappings: {
    mobile: { width: 640, height: 960 },
    tablet: { width: 1024, height: 1366 },
    desktop: { width: 1920, height: 1080 }
  },
  timestampConfig: {
    font: 'Arial',
    fontSize: 24,
    rgba: true
  }
};



const loadConfig = async () => {
  return DEFAULT_CONFIG;
};

const validateDeviceConfig = (config, deviceType) => {
  if (!config || typeof config !== 'object') {
    console.warn(`Invalid ${deviceType} config, using defaults`);
    return DEFAULT_CONFIG.deviceMappings[deviceType];
  }

  const { width, height } = config;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    console.warn(`Invalid dimensions in ${deviceType} config, using defaults`);
    return DEFAULT_CONFIG.deviceMappings[deviceType];
  }

  return { width, height };
};

// const validateTimestampConfig = (config) => {
//   if (!config || typeof config !== 'object') {
//     console.warn('Invalid timestamp config, using defaults');
//     return DEFAULT_CONFIG.timestampConfig;
//   }

//   const validatedConfig = {
//     font: validateFont(config.font),
//     fontSize: validateFontSize(config.fontSize),
//     rgba: typeof config.rgba === 'boolean' ? config.rgba : DEFAULT_CONFIG.timestampConfig.rgba
//   };

//   return validatedConfig;
// };

// const validateFont = (font) => {
//   const validFonts = ['Arial', 'Helvetica', 'Times New Roman', 'Courier'];
//   if (typeof font !== 'string' || !validFonts.includes(font)) {
//     console.warn(`Invalid font ${font}, using default`);
//     return DEFAULT_CONFIG.timestampConfig.font;
//   }
//   return font;
// };

// const validateFontSize = (fontSize) => {
//   if (!Number.isInteger(fontSize) || fontSize < 8 || fontSize > 72) {
//     console.warn(`Invalid font size ${fontSize}, using default`);
//     return DEFAULT_CONFIG.timestampConfig.fontSize;
//   }
//   return fontSize;
// };

exports.handler = async (event) => {
  const { getObjectContext } = event;

  try {
    // Load configuration with defaults
    const config = await loadConfig();
    const { deviceMappings, timestampConfig } = config;

    // Get the original object
    const originalObject = await s3.getObject({
      Bucket: getObjectContext.inputS3Url.split('/')[2],
      Key: decodeURIComponent(getObjectContext.inputS3Url.split('/').slice(3).join('/')),
    }).promise();

    if (!originalObject.Body) {
      throw new Error('Empty object body');
    }

    // Determine device type from headers with desktop as fallback
    const isMobile = event.userRequest.headers['CloudFront-Is-Mobile-Viewer'] === 'true';
    const isTablet = event.userRequest.headers['CloudFront-Is-Tablet-Viewer'] === 'true';
    const deviceType = isMobile ? 'mobile' : (isTablet ? 'tablet' : 'desktop');
    const { width, height } = deviceMappings[deviceType];

    // Process the image
    let processedImage = Sharp(originalObject.Body);

    // Resize image based on device type
    processedImage = processedImage.resize(width, height, {
      fit: 'inside',
      withoutEnlargement: true,
    });

    // Add timestamp to the image
    const timestamp = new Date().toISOString();
    try {
      processedImage = processedImage.composite([{
        input: {
          text: {
            text: timestamp,
            font: timestampConfig.font,
            fontSize: timestampConfig.fontSize,
            rgba: timestampConfig.rgba,
          },
        },
        gravity: 'south',
      }]);
    } catch (error) {
      console.error('Error adding timestamp to image:', error);
      // Continue processing without timestamp if it fails
    }

    // Get the processed buffer
    const processedBuffer = await processedImage.toBuffer();

    // Write the transformed object back to S3
    await s3.writeGetObjectResponse({
      RequestRoute: getObjectContext.outputRoute,
      RequestToken: getObjectContext.outputToken,
      Body: processedBuffer,
      ContentType: originalObject.ContentType,
      Metadata: {
        'device-type': deviceType,
        'processing-timestamp': timestamp,
        'config-source': config === DEFAULT_CONFIG ? 'defaults' : 'parameter-store',
      },
    }).promise();

  } catch (error) {
    console.error('Error processing image:', error);
    throw error;
  }
};
