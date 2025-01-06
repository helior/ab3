import AWS from "aws-sdk";
// import sharp from "sharp";

const s3 = new AWS.S3();
const ssm = new AWS.SSM();

export async function handler(event) {
  const bucketName = process.env.BUCKET_NAME;
  const objectKey = event.pathParameters.S3ObjectKey;
  console.log(event.headers, 'hheaders')
  // Get device information from headers
  const device = event && event.headers && event.headers["cloudfront-is-mobile-viewer"]
    ? "mobile"
    : event && event.headers && event.headers["cloudfront-is-tablet-viewer"]
    ? "tablet"
    : "desktop";

  // Fetch image from S3
  const object = await s3.getObject({ Bucket: bucketName, Key: objectKey }).promise();

  // Fetch configuration from Parameter Store
  const resolutionParam = await ssm.getParameter({ Name: `/image-processor/device-mappings/${device}` }).promise();
  const resolution = JSON.parse(resolutionParam.Parameter.Value);
  console.log(resolution);

  // // Resize and watermark image
  // const resizedImage = await sharp(object.Body)
  //   .resize(resolution.width, resolution.height)
  //   .composite([{ input: createWatermark(), gravity: "southeast" }])
  //   .toBuffer();

  return {
    statusCode: 200,
    headers: { "Content-Type": "image/png", "x-device": device, "x-device-resolution":  resolutionParam.Parameter.Value}, // Fixme: where do I get the headers from the original S3 object?
    // body: resizedImage.toString("base64"),
    body: object.Body.toString("base64"),
    isBase64Encoded: true,
  };
}

function createWatermark() {
  const timestamp = new Date().toISOString();
  return Buffer.from(
    `<svg height="50" width="200"><text x="10" y="30" font-size="20" fill="white">${timestamp}</text></svg>`
  );
}
