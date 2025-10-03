// Image processing utility for converting images to N scales of grey
// This ensures any uploaded image is optimized for the ASCII effect

function processImageToGreys(imgElement, numLevels = 6) {
  // Create a temporary canvas for processing
  const tempCanvas = document.createElement('canvas');
  const ctx = tempCanvas.getContext('2d');

  // Set canvas to match image dimensions
  tempCanvas.width = imgElement.width;
  tempCanvas.height = imgElement.height;

  // Draw the original image
  ctx.drawImage(imgElement, 0, 0, imgElement.width, imgElement.height);

  // Get image data
  const imageData = ctx.getImageData(0, 0, tempCanvas.width, tempCanvas.height);
  const data = imageData.data;

  // Generate grey scale levels based on numLevels
  const greyLevels = [];
  for (let i = 0; i < numLevels; i++) {
    greyLevels.push(Math.round((255 / (numLevels - 1)) * i));
  }

  // Process each pixel
  for (let i = 0; i < data.length; i += 4) {
    // Calculate luminance (weighted grayscale conversion)
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const grey = 0.299 * r + 0.587 * g + 0.114 * b;

    // Map to nearest grey level
    let nearestGrey = greyLevels[0];
    let minDiff = Math.abs(grey - nearestGrey);

    for (let j = 1; j < greyLevels.length; j++) {
      const diff = Math.abs(grey - greyLevels[j]);
      if (diff < minDiff) {
        minDiff = diff;
        nearestGrey = greyLevels[j];
      }
    }

    // Set pixel to grey level
    data[i] = nearestGrey;
    data[i + 1] = nearestGrey;
    data[i + 2] = nearestGrey;
    // Alpha channel (i + 3) remains unchanged
  }

  // Put processed data back
  ctx.putImageData(imageData, 0, 0);

  // Convert canvas to image
  const processedImg = new Image();
  processedImg.src = tempCanvas.toDataURL();

  return processedImg;
}

// Function to resize image for optimal performance
function optimizeImageSize(imgElement, maxDimension = 800) {
  const tempCanvas = document.createElement('canvas');
  const ctx = tempCanvas.getContext('2d');

  let width = imgElement.width;
  let height = imgElement.height;

  // Calculate new dimensions maintaining aspect ratio
  if (width > maxDimension || height > maxDimension) {
    const aspectRatio = width / height;
    if (width > height) {
      width = maxDimension;
      height = Math.round(maxDimension / aspectRatio);
    } else {
      height = maxDimension;
      width = Math.round(maxDimension * aspectRatio);
    }
  }

  tempCanvas.width = width;
  tempCanvas.height = height;

  // Draw resized image
  ctx.drawImage(imgElement, 0, 0, width, height);

  const resizedImg = new Image();
  resizedImg.src = tempCanvas.toDataURL();

  return resizedImg;
}
