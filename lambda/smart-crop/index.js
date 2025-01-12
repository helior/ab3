import { S3 } from '@aws-sdk/client-s3';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { RekognitionClient, DetectFacesCommand } from "@aws-sdk/client-rekognition";
import sharp from 'sharp';

const s3 = new S3();
const rekognitionClient = new RekognitionClient();

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}


function handleBounds(response) {
  if (!response.FaceDetails || response.FaceDetails.length <= 0) {
    return { Height: 1, Left: 0, Top: 0, Width: 1 };
  }

  // Initialize bounds with the first face's values
  let minLeft = response.FaceDetails[0].BoundingBox.Left;
  let minTop = response.FaceDetails[0].BoundingBox.Top;
  let maxRight = response.FaceDetails[0].BoundingBox.Left + response.FaceDetails[0].BoundingBox.Width;
  let maxBottom = response.FaceDetails[0].BoundingBox.Top + response.FaceDetails[0].BoundingBox.Height;

  // Find the min/max bounds across all faces
  for (const face of response.FaceDetails) {
    const box = face.BoundingBox;

    // Find leftmost and topmost points
    minLeft = Math.min(minLeft, box.Left);
    minTop = Math.min(minTop, box.Top);

    // Find rightmost and bottommost points
    maxRight = Math.max(maxRight, box.Left + box.Width);
    maxBottom = Math.max(maxBottom, box.Top + box.Height);
  }

  // Ensure bounds are within 0-1 range
  const boundingBox = {
    Left: Math.max(0, minLeft),
    Top: Math.max(0, minTop),
    Width: Math.min(1, maxRight) - Math.max(0, minLeft),
    Height: Math.min(1, maxBottom) - Math.max(0, minTop)
  };

  // Handle bounds greater than the size of the image
  if (boundingBox.Left + boundingBox.Width > 1) {
    boundingBox.Width = 1 - boundingBox.Left;
  }
  if (boundingBox.Top + boundingBox.Height > 1) {
    boundingBox.Height = 1 - boundingBox.Top;
  }

  return boundingBox;
}

async function getBoundingBox(faceResults) {
  try {
    const response = faceResults;
    const boundingBox = handleBounds(response);

    // console.log('⭐️ boundingBox', boundingBox);
    return {
      height: boundingBox.Height,
      left: boundingBox.Left,
      top: boundingBox.Top,
      width: boundingBox.Width,
    };
  } catch (error) {
    console.error(error);
    if (error.message.includes("Cannot read property 'BoundingBox'")) {
      console.error("Error processing face detection results. Please ensure valid face detection data is provided.");
    } else {
      console.error(error);
    }
    // Return full image bounds in case of error
    return { height: 1, left: 0, top: 0, width: 1 };
  }
}

function getCropArea(boundingBox, padding, boxSize) {
  // calculate needed options dimensions
  let left = Math.floor(boundingBox.left * boxSize.width - padding);
  let top = Math.floor(boundingBox.top * boxSize.height - padding);
  let extractWidth = Math.floor(boundingBox.width * boxSize.width + padding * 2);
  let extractHeight = Math.floor(boundingBox.height * boxSize.height + padding * 2);

  // check if dimensions fit within image dimensions and re-adjust if necessary
  left = left < 0 ? 0 : left;
  top = top < 0 ? 0 : top;
  const maxWidth = boxSize.width - left;
  const maxHeight = boxSize.height - top;
  extractWidth = extractWidth > maxWidth ? maxWidth : extractWidth;
  extractHeight = extractHeight > maxHeight ? maxHeight : extractHeight;

  // Calculate the smart crop area
  return {
    left,
    top,
    width: extractWidth,
    height: extractHeight,
  };
}

exports.handler = async (event) => {
  // console.log('⭐️ SmartCrop event:', JSON.stringify(event, null, 2));
  const { bucket, key } = event.s3;
  const s3Client = new S3Client();
  const faceResults = event.faceResults;
  try {
    const getCommand = new GetObjectCommand({
      Bucket: bucket,
      Key: key
    });
    const { Body, ContentType } = await s3Client.send(getCommand);
    const imageBuffer = await streamToBuffer(Body);

    const faceIndex = 0;
    const padding = 0;

    // Crop (Smart-esque)
    const sharpImage = sharp(imageBuffer);
    const metadata = await sharpImage.metadata();
    // console.log('⭐️ metadata', metadata);

    // Or... use Step Function results
    const boundingBox = await getBoundingBox(faceResults, faceIndex);
    // console.log('⭐️ resulting Bounding box', boundingBox);
    const cropArea = getCropArea(boundingBox, padding, metadata);
    // console.log('⭐️ cropArea', cropArea)

    const cropped = await sharpImage
      .extract(cropArea)
      .toBuffer();

    // console.log('⭐️ cropped', cropped)
    const putCommand = new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: cropped,
      ContentType: ContentType
    });

    await s3Client.send(putCommand);

    return { statusCode: 200 }

  } catch (error) {
    console.error('Error:', error);
    throw error;
  }
};
