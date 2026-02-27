import * as tf from '@tensorflow/tfjs';
import * as blazeface from '@tensorflow-models/blazeface';
import { SelfieSegmentation } from '@mediapipe/selfie_segmentation';
import type { Results } from '@mediapipe/selfie_segmentation';

export interface ProcessSettings {
    applyBeautify: boolean;
    useBlueBg: boolean;
    rotation?: number;
}

export class ImagePipeline {
    private static instance: ImagePipeline;
    private isInitialized = false;

    private blazefaceModel: blazeface.BlazeFaceModel | null = null;
    private segmentation: SelfieSegmentation | null = null;

    // Temporary storage for segmentation results to untangle callback logic
    private activeSegmentationResolve: ((mask: ImageBitmap | HTMLCanvasElement) => void) | null = null;

    private constructor() { }

    public static getInstance(): ImagePipeline {
        if (!ImagePipeline.instance) {
            ImagePipeline.instance = new ImagePipeline();
        }
        return ImagePipeline.instance;
    }

    public async initialize(): Promise<void> {
        if (this.isInitialized) return;

        console.log('Initializing ML models...');
        await tf.setBackend('webgl');
        await tf.ready();
        this.blazefaceModel = await blazeface.load();

        this.segmentation = new SelfieSegmentation({
            locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation/${file}`,
        });

        this.segmentation.setOptions({
            modelSelection: 1, // 1 is landscape/fast model, 0 is general
        });

        this.segmentation.onResults((results: Results) => {
            if (this.activeSegmentationResolve) {
                this.activeSegmentationResolve((results.segmentationMask as unknown) as ImageBitmap);
                this.activeSegmentationResolve = null;
            }
        });

        // Warm up the models
        const dummyCanvas = document.createElement('canvas');
        dummyCanvas.width = 100; dummyCanvas.height = 100;
        const dummyCtx = dummyCanvas.getContext('2d');
        dummyCtx?.fillRect(0, 0, 100, 100);

        await this.blazefaceModel.estimateFaces(dummyCanvas, false);
        await this.segmentation.send({ image: dummyCanvas });

        this.isInitialized = true;
        console.log('ML models initialized.');
    }

    private getSegmentationMask(image: HTMLImageElement | HTMLCanvasElement): Promise<ImageBitmap | HTMLCanvasElement> {
        return new Promise((resolve) => {
            this.activeSegmentationResolve = resolve;
            this.segmentation!.send({ image });
        });
    }

    /**
     * Applies a simple softening filter to simulate face clean/beautification 
     * (edge preserving bilateral filter is too slow in pure JS, using pseudo-soft-focus)
     */
    private applyBeautification(ctx: CanvasRenderingContext2D, sourceCanvas: HTMLCanvasElement) {
        // We achieve a "glamour glow" / soft focus by overlaying a blurred version of the image with lighter blending
        ctx.save();
        ctx.globalAlpha = 0.5;
        ctx.filter = 'blur(4px)';
        ctx.drawImage(sourceCanvas, 0, 0);
        ctx.restore();

        // Add slightly more brightness/contrast to simulate clean skin
        ctx.save();
        ctx.globalAlpha = 0.2;
        ctx.globalCompositeOperation = 'screen';
        ctx.drawImage(sourceCanvas, 0, 0);
        ctx.restore();
    }

    public async processImage(
        sourceImage: HTMLImageElement,
        settings: ProcessSettings
    ): Promise<string> {
        if (!this.isInitialized) {
            await this.initialize();
        }

        const { width, height } = sourceImage;

        let workingCanvas: HTMLImageElement | HTMLCanvasElement = sourceImage;

        // 0. Pre-process Rotation if needed
        if (settings.rotation) {
            console.log(`Applying rotation ${settings.rotation}`);
            const rotCanvas = document.createElement('canvas');
            const rotCtx = rotCanvas.getContext('2d')!;

            // Swap dimensions if rotating 90 or 270 degrees
            if (settings.rotation % 180 !== 0) {
                rotCanvas.width = height;
                rotCanvas.height = width;
            } else {
                rotCanvas.width = width;
                rotCanvas.height = height;
            }

            rotCtx.translate(rotCanvas.width / 2, rotCanvas.height / 2);
            rotCtx.rotate((settings.rotation * Math.PI) / 180);
            rotCtx.drawImage(sourceImage, -width / 2, -height / 2);

            workingCanvas = rotCanvas;
        }

        const workingWidth = workingCanvas.width;
        const workingHeight = workingCanvas.height;

        // 1. Get Segmentation Mask
        console.log('Segmenting subject...');
        const segmentationMask = await this.getSegmentationMask(workingCanvas);

        // 2. Prepare isolated person canvas
        const personCanvas = document.createElement('canvas');
        personCanvas.width = workingWidth;
        personCanvas.height = workingHeight;
        const personCtx = personCanvas.getContext('2d')!;
        personCtx.imageSmoothingEnabled = true;
        personCtx.imageSmoothingQuality = 'high';

        // Draw the mask
        personCtx.drawImage(segmentationMask, 0, 0, workingWidth, workingHeight);
        // Source-in to keep only the pixels of the source image where the mask is opaque
        personCtx.globalCompositeOperation = 'source-in';
        personCtx.drawImage(workingCanvas, 0, 0, workingWidth, workingHeight);

        // 3. Face Detection for auto-crop
        console.log('Detecting face...');
        const predictions = await this.blazefaceModel!.estimateFaces(personCanvas, false);

        let cropX = 0, cropY = 0, cropW = workingWidth, cropH = workingHeight;

        if (predictions.length > 0) {
            // Find largest face for cropping
            const face = predictions[0];
            const topLeft = face.topLeft as [number, number];
            const bottomRight = face.bottomRight as [number, number];

            const faceW = bottomRight[0] - topLeft[0];
            const faceH = bottomRight[1] - topLeft[1];
            const faceCenterX = topLeft[0] + faceW / 2;
            const faceCenterY = topLeft[1] + faceH / 2;

            // Passport standard: head height is ~ 70-80% of total height.
            // Aspect ratio for 2x2 inch is 1:1. 
            // The BlazeFace bounding box usually tightly bounds the facial features (forehead to chin).
            // We need to expand it to include hair, neck, and shoulders.
            // E.g., targetHeight = faceH / 0.5 (to make face 50% of the passport photo vertically)

            const targetHeight = faceH * 2.5;
            const targetWidth = targetHeight; // 1:1 aspect ratio for 2x2 inch

            cropW = targetWidth;
            cropH = targetHeight;
            cropX = Math.max(0, faceCenterX - targetWidth / 2);

            // Face center is usually at 40-50% from the top of the photo.
            // We offset the cropY to leave more space above the head.
            cropY = Math.max(0, faceCenterY - targetHeight * 0.4);

            // Clamp to image boundaries
            if (cropX + cropW > workingWidth) cropW = workingWidth - cropX;
            if (cropY + cropH > workingHeight) cropH = workingHeight - cropY;
        } else {
            console.warn("No faces detected, proceeding without autocrop!");
            // As a fallback, ensure 1:1 crop from center
            const size = Math.min(workingWidth, workingHeight);
            cropW = size;
            cropH = size;
            cropX = (workingWidth - size) / 2;
            cropY = (workingHeight - size) / 2;
        }

        // 4. Final Render Canvas
        const finalCanvas = document.createElement('canvas');
        // Output at the original cropped resolution to preserve maximum quality
        finalCanvas.width = Math.max(Math.floor(cropW), 1);
        finalCanvas.height = Math.max(Math.floor(cropH), 1);
        const finalCtx = finalCanvas.getContext('2d')!;
        finalCtx.imageSmoothingEnabled = true;
        finalCtx.imageSmoothingQuality = 'high';

        // Draw background
        finalCtx.fillStyle = settings.useBlueBg ? '#3b82f6' : '#ffffff';
        finalCtx.fillRect(0, 0, finalCanvas.width, finalCanvas.height);

        // Draw cropped person
        const tempCropCanvas = document.createElement('canvas');
        tempCropCanvas.width = finalCanvas.width;
        tempCropCanvas.height = finalCanvas.height;
        const tempCropCtx = tempCropCanvas.getContext('2d')!;
        tempCropCtx.imageSmoothingEnabled = true;
        tempCropCtx.imageSmoothingQuality = 'high';

        // Draw the isoloated person onto the crop canvas scaled to 600x600
        tempCropCtx.drawImage(
            personCanvas,
            cropX, cropY, cropW, Math.max(cropH, 1), // Source
            0, 0, finalCanvas.width, finalCanvas.height // Destination
        );

        // Apply beautification on the isolated person layer if requested
        if (settings.applyBeautify) {
            this.applyBeautification(tempCropCtx, tempCropCanvas);
        }

        // Compose final
        finalCtx.drawImage(tempCropCanvas, 0, 0);

        return new Promise((resolve, reject) => {
            finalCanvas.toBlob((blob) => {
                if (blob) {
                    resolve(URL.createObjectURL(blob));
                } else {
                    reject(new Error('Failed to generate image blob'));
                }
            }, 'image/jpeg', 1.0); // Maximum quality JPEG
        });
    }
}
