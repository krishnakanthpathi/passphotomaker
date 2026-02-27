import { useState, useCallback, useRef, useEffect } from 'react';
import { useDropzone } from 'react-dropzone';
import { Upload, Settings, LayoutGrid, Download, Printer, RefreshCcw } from 'lucide-react';
import { ImagePipeline } from './services/imagePipeline';
import { jsPDF } from 'jspdf';
import './App.css';

function App() {
  const [paperSize, setPaperSize] = useState<'A4' | '4x6'>('4x6');
  const [paperOrientation, setPaperOrientation] = useState<'portrait' | 'landscape'>('portrait');
  const [gridCount, setGridCount] = useState<3 | 4 | 6 | 8>(6);
  const [gapPaddingX, setGapPaddingX] = useState<number>(20); // Horizontal Gap px
  const [gapPaddingY, setGapPaddingY] = useState<number>(20); // Vertical Gap px
  const [pageMarginX, setPageMarginX] = useState<number>(30); // Horizontal Page Margin px
  const [pageMarginY, setPageMarginY] = useState<number>(30); // Vertical Page Margin px
  const [rotationDegree, setRotationDegree] = useState<number>(0);
  const [useBlueBg, setUseBlueBg] = useState(false);
  const [applyBeautify, setApplyBeautify] = useState(true);

  const [sourceImageObjectURL, setSourceImageObjectURL] = useState<string | null>(null);
  const [processedImageUrl, setProcessedImageUrl] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);

  const canvasRef = useRef<HTMLCanvasElement>(null);

  const onDrop = useCallback((acceptedFiles: File[]) => {
    const file = acceptedFiles[0];
    if (file) {
      const url = URL.createObjectURL(file);
      setSourceImageObjectURL(url);
    }
  }, []);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: { 'image/jpeg': ['.jpeg', '.jpg'], 'image/png': ['.png'] },
    maxFiles: 1
  });

  // Effect to process image whenever source, bg setting, or beautify changes
  useEffect(() => {
    if (!sourceImageObjectURL) {
      setProcessedImageUrl(null);
      return;
    }

    let isSubscribed = true;

    const process = async () => {
      setIsProcessing(true);
      try {
        const img = new Image();
        img.src = sourceImageObjectURL;
        await new Promise((resolve) => {
          img.onload = resolve;
        });

        const pipeline = ImagePipeline.getInstance();
        const resultUrl = await pipeline.processImage(img, {
          applyBeautify,
          useBlueBg,
          rotation: rotationDegree
        });

        if (isSubscribed) {
          setProcessedImageUrl(resultUrl);
        }
      } catch (err) {
        console.error("Failed to process image", err);
      } finally {
        if (isSubscribed) {
          setIsProcessing(false);
        }
      }
    };

    process();

    return () => {
      isSubscribed = false;
    };
  }, [sourceImageObjectURL, useBlueBg, applyBeautify]);

  // Effect to render grid onto canvas whenever layout settings or processed image changes
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Constants for rendering at reasonable internal resolution (approx 300dpi)
    let canvasWidthInPx: number;
    let canvasHeightInPx: number;

    // 300 DPI: 
    // 4x6 inches -> 1200 x 1800 px
    // A4 (210x297mm) -> approx 8.27 x 11.69 inches -> 2480 x 3508 px
    if (paperSize === 'A4') {
      canvasWidthInPx = paperOrientation === 'portrait' ? 2480 : 3508;
      canvasHeightInPx = paperOrientation === 'portrait' ? 3508 : 2480;
    } else {
      // 4x6 photo paper (300 DPI -> 1200x1800)
      canvasWidthInPx = paperOrientation === 'portrait' ? 1200 : 1800;
      canvasHeightInPx = paperOrientation === 'portrait' ? 1800 : 1200;
    }

    canvas.width = canvasWidthInPx;
    canvas.height = canvasHeightInPx;

    // Draw white background
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvasWidthInPx, canvasHeightInPx);

    if (!processedImageUrl) return;

    const img = new Image();
    img.src = processedImageUrl;
    img.onload = () => {
      let cols = 2;
      let rows = 2;

      if (paperSize === '4x6') {
        if (paperOrientation === 'portrait') {
          if (gridCount === 3 || gridCount === 4) { cols = 2; rows = 2; }
          else if (gridCount === 6) { cols = 2; rows = 3; }
          else if (gridCount === 8) { cols = 2; rows = 4; }
        } else {
          if (gridCount === 3 || gridCount === 4) { cols = 2; rows = 2; }
          else if (gridCount === 6) { cols = 3; rows = 2; }
          else if (gridCount === 8) { cols = 4; rows = 2; }
        }
      } else {
        if (paperOrientation === 'portrait') {
          if (gridCount === 3) { cols = 2; rows = 2; }
          else if (gridCount === 4) { cols = 2; rows = 2; }
          else if (gridCount === 6) { cols = 2; rows = 3; }
          else if (gridCount === 8) { cols = 2; rows = 4; }
        } else {
          if (gridCount === 3) { cols = 3; rows = 1; }
          else if (gridCount === 4) { cols = 2; rows = 2; }
          else if (gridCount === 6) { cols = 3; rows = 2; }
          else if (gridCount === 8) { cols = 4; rows = 2; }
        }
      }

      // 2x2 inch passport dimension is 1:1 aspect ratio. 
      const targetPhotoWidth = 600;
      const targetPhotoHeight = 600;

      // Base margin logic with adjustable padding between photos
      const effectivePaddingX = gapPaddingX * 3; // Scale gap factor to match 300dpi standard
      const effectivePaddingY = gapPaddingY * 3;

      // Calculate total drawn area
      const totalWidth = (cols * targetPhotoWidth) + ((cols - 1) * effectivePaddingX);
      const totalHeight = (rows * targetPhotoHeight) + ((rows - 1) * effectivePaddingY);

      const effectiveMarginX = pageMarginX * 3; // Scale to 300dpi
      const effectiveMarginY = pageMarginY * 3; // Scale to 300dpi

      // Constrain available space
      const safeWidth = canvasWidthInPx - (effectiveMarginX * 2);
      const safeHeight = canvasHeightInPx - (effectiveMarginY * 2);

      // Calculate scale to fit inside safe area if it overflows
      let scale = 1;
      if (totalWidth > safeWidth || totalHeight > safeHeight) {
        scale = Math.min(safeWidth / totalWidth, safeHeight / totalHeight);
      }

      const scaledWidth = totalWidth * scale;
      const scaledHeight = totalHeight * scale;

      // Center the scaled block in the canvas
      let startX = (canvasWidthInPx - scaledWidth) / 2;
      let startY = (canvasHeightInPx - scaledHeight) / 2;

      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          // If we only need 3 photos but grid is 2x2, skip the last one
          if (r * cols + c >= gridCount) continue;

          const x = startX + (c * (targetPhotoWidth + effectivePaddingX)) * scale;
          const y = startY + (r * (targetPhotoHeight + effectivePaddingY)) * scale;

          const scaledTargetWidth = targetPhotoWidth * scale;
          const scaledTargetHeight = targetPhotoHeight * scale;

          // Add border and shadow for printing cut marks (optional, but a light gray border helps)
          ctx.strokeStyle = '#e2e8f0';
          ctx.lineWidth = 2;
          ctx.strokeRect(x, y, scaledTargetWidth, scaledTargetHeight);

          // Draw the image
          ctx.drawImage(img, x, y, scaledTargetWidth, scaledTargetHeight);
        }
      }
    };

  }, [paperSize, paperOrientation, gridCount, gapPaddingX, gapPaddingY, pageMarginX, pageMarginY, processedImageUrl]);

  const handleExportJpg = () => {
    if (!canvasRef.current) return;
    const dataUrl = canvasRef.current.toDataURL('image/jpeg', 1.0); // Max quality
    const link = document.createElement('a');
    link.href = dataUrl;
    link.download = `passport-photos-${paperSize}.jpg`;
    link.click();
  };

  const handleGeneratePdf = () => {
    if (!canvasRef.current) return;
    const isA4 = paperSize === 'A4';
    const pdf = new jsPDF({
      orientation: paperOrientation,
      unit: 'mm',
      format: isA4 ? 'a4' : (paperOrientation === 'portrait' ? [101.6, 152.4] : [152.4, 101.6])
    });

    const imgData = canvasRef.current.toDataURL('image/jpeg', 1.0); // Max quality
    const pdfWidth = pdf.internal.pageSize.getWidth();
    const pdfHeight = pdf.internal.pageSize.getHeight();

    pdf.addImage(imgData, 'JPEG', 0, 0, pdfWidth, pdfHeight);
    pdf.save(`passport-photos-${paperSize}.pdf`);
  };

  return (
    <div className="flex flex-col md:flex-row h-screen bg-surface-50 overflow-hidden font-sans">

      {/* Sidebar Controls */}
      <aside className="w-full md:w-80 bg-white border-t md:border-t-0 md:border-r border-surface-200 flex flex-col shadow-sm z-20 h-[55vh] md:h-screen shrink-0 order-2 md:order-1">
        <div className="p-4 md:p-6 border-b border-surface-200 shrink-0 flex justify-between items-center">
          <div>
            <h1 className="text-lg md:text-xl font-bold text-surface-900 flex items-center gap-2">
              <LayoutGrid className="text-primary-600 w-5 h-5 md:w-6 md:h-6" />
              Passport Photo Maker
            </h1>
            <p className="text-xs md:text-sm text-surface-700 mt-0.5 md:mt-1">Local processing only.</p>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-4 md:p-6 space-y-6">
          {/* Upload Section */}
          <section>
            <h2 className="text-sm font-semibold text-surface-900 uppercase tracking-wider mb-3">
              1. Upload Photo
            </h2>
            <div
              {...getRootProps()}
              className={`border-2 border-dashed rounded-xl p-6 flex flex-col items-center justify-center text-center cursor-pointer transition-colors ${isDragActive ? 'border-primary-500 bg-primary-50' : 'border-surface-200 hover:border-primary-500 hover:bg-primary-50'
                }`}
            >
              <input {...getInputProps()} />
              {sourceImageObjectURL ? (
                <div className="flex flex-col items-center">
                  <img src={sourceImageObjectURL} alt="Source Preview" className="w-16 h-16 object-cover rounded-lg mb-2 shadow-sm" />
                  <p className="text-xs font-medium text-primary-600 flex items-center gap-1">
                    <RefreshCcw className="w-3 h-3" />
                    Replace Photo
                  </p>
                </div>
              ) : (
                <>
                  <Upload className="w-8 h-8 text-surface-700 mb-2" />
                  <p className="text-sm font-medium text-surface-900">Drag & drop photo</p>
                  <p className="text-xs text-surface-700 mt-1">JPG or PNG</p>
                </>
              )}
            </div>
            {isProcessing && <p className="text-xs text-primary-600 mt-2 flex items-center justify-center gap-1">
              <RefreshCcw className="w-3 h-3 animate-spin" /> Processing magic...
            </p>}
          </section>

          {/* Settings Section */}
          <section className={!sourceImageObjectURL ? 'opacity-50 pointer-events-none' : ''}>
            <h2 className="text-sm font-semibold text-surface-900 uppercase tracking-wider mb-3 flex items-center gap-2">
              <Settings className="w-4 h-4" />
              2. Print Settings
            </h2>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-surface-900 mb-1">Paper Size & Orientation</label>
                <div className="grid grid-cols-2 gap-2 mb-2">
                  <button
                    onClick={() => setPaperSize('4x6')}
                    className={`py-2 px-3 text-sm font-medium rounded-lg border transition-colors ${paperSize === '4x6' ? 'bg-primary-50 border-primary-500 text-primary-700' : 'border-surface-200 text-surface-700 hover:bg-surface-50'}`}
                  >
                    4x6 (Photo)
                  </button>
                  <button
                    onClick={() => setPaperSize('A4')}
                    className={`py-2 px-3 text-sm font-medium rounded-lg border transition-colors ${paperSize === 'A4' ? 'bg-primary-50 border-primary-500 text-primary-700' : 'border-surface-200 text-surface-700 hover:bg-surface-50'}`}
                  >
                    A4
                  </button>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    onClick={() => setPaperOrientation('portrait')}
                    className={`py-1.5 px-3 text-sm font-medium rounded-lg border transition-colors ${paperOrientation === 'portrait' ? 'bg-primary-50 border-primary-500 text-primary-700' : 'border-surface-200 text-surface-700 hover:bg-surface-50'}`}
                  >
                    Portrait
                  </button>
                  <button
                    onClick={() => setPaperOrientation('landscape')}
                    className={`py-1.5 px-3 text-sm font-medium rounded-lg border transition-colors ${paperOrientation === 'landscape' ? 'bg-primary-50 border-primary-500 text-primary-700' : 'border-surface-200 text-surface-700 hover:bg-surface-50'}`}
                  >
                    Landscape
                  </button>
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-surface-900 mb-1">Grid Layout</label>
                <div className="grid grid-cols-4 gap-2 mb-4">
                  {[3, 4, 6, 8].map((count) => (
                    <button
                      key={count}
                      onClick={() => setGridCount(count as 3 | 4 | 6 | 8)}
                      className={`py-2 px-2 text-sm font-medium rounded-lg border transition-colors ${gridCount === count ? 'bg-primary-50 border-primary-500 text-primary-700' : 'border-surface-200 text-surface-700 hover:bg-surface-50'}`}
                    >
                      {count}
                    </button>
                  ))}
                </div>

                <div className="space-y-3">
                  <div>
                    <label className="block text-sm font-medium text-surface-900 mb-1 flex justify-between">
                      <span>Horizontal Gap</span>
                      <span className="text-surface-500 font-normal">{gapPaddingX}px</span>
                    </label>
                    <input
                      type="range"
                      min="0"
                      max="100"
                      value={gapPaddingX}
                      onChange={(e) => setGapPaddingX(Number(e.target.value))}
                      className="w-full align-middle accent-primary-600 appearance-none bg-surface-200 h-1.5 rounded-full cursor-pointer"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-surface-900 mb-1 flex justify-between">
                      <span>Vertical Gap</span>
                      <span className="text-surface-500 font-normal">{gapPaddingY}px</span>
                    </label>
                    <input
                      type="range"
                      min="0"
                      max="100"
                      value={gapPaddingY}
                      onChange={(e) => setGapPaddingY(Number(e.target.value))}
                      className="w-full align-middle accent-primary-600 appearance-none bg-surface-200 h-1.5 rounded-full cursor-pointer"
                    />
                  </div>
                </div>
              </div>

              <div className="space-y-3">
                <div>
                  <label className="block text-sm font-medium text-surface-900 mb-1 flex justify-between">
                    <span>Horizontal Page Margin</span>
                    <span className="text-surface-500 font-normal">{pageMarginX}px</span>
                  </label>
                  <input
                    type="range"
                    min="0"
                    max="100"
                    value={pageMarginX}
                    onChange={(e) => setPageMarginX(Number(e.target.value))}
                    className="w-full align-middle accent-primary-600 appearance-none bg-surface-200 h-1.5 rounded-full cursor-pointer"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-surface-900 mb-1 flex justify-between">
                    <span>Vertical Page Margin</span>
                    <span className="text-surface-500 font-normal">{pageMarginY}px</span>
                  </label>
                  <input
                    type="range"
                    min="0"
                    max="100"
                    value={pageMarginY}
                    onChange={(e) => setPageMarginY(Number(e.target.value))}
                    className="w-full align-middle accent-primary-600 appearance-none bg-surface-200 h-1.5 rounded-full cursor-pointer"
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-surface-900 mb-1 flex justify-between">
                  <span>Image Rotation</span>
                  <span className="text-surface-500 font-normal">{rotationDegree}°</span>
                </label>
                <input
                  type="range"
                  min="-180"
                  max="180"
                  step="90"
                  value={rotationDegree}
                  onChange={(e) => setRotationDegree(Number(e.target.value))}
                  className="w-full align-middle accent-primary-600 appearance-none bg-surface-200 h-1.5 rounded-full cursor-pointer"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-surface-900 mb-1">Enhancements (AI)</label>
                <label className="flex items-center gap-2 cursor-pointer mt-2">
                  <input
                    type="checkbox"
                    className="w-4 h-4 rounded text-primary-600 focus:ring-primary-500 border-surface-200"
                    checked={applyBeautify}
                    onChange={(e) => setApplyBeautify(e.target.checked)}
                  />
                  <span className="text-sm text-surface-900">Auto Face Clean / Smoothing</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer mt-2">
                  <input
                    type="checkbox"
                    className="w-4 h-4 rounded text-primary-600 focus:ring-primary-500 border-surface-200"
                    checked={useBlueBg}
                    onChange={(e) => setUseBlueBg(e.target.checked)}
                  />
                  <span className="text-sm text-surface-900">Replace Background (Blue)</span>
                </label>
              </div>
            </div>
          </section>
        </div>

        <div className="p-4 md:p-6 border-t border-surface-200 space-y-3 bg-surface-50 shrink-0">
          <button
            onClick={handleExportJpg}
            disabled={!processedImageUrl}
            className="w-full py-2.5 px-4 bg-primary-600 hover:bg-primary-700 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-xl font-medium shadow-sm transition-colors flex items-center justify-center gap-2"
          >
            <Download className="w-4 h-4" />
            Export High-Res JPG
          </button>
          <button
            onClick={handleGeneratePdf}
            disabled={!processedImageUrl}
            className="w-full py-2.5 px-4 bg-white border border-surface-200 hover:bg-surface-50 disabled:opacity-50 disabled:cursor-not-allowed text-surface-900 rounded-xl font-medium shadow-sm transition-colors flex items-center justify-center gap-2"
          >
            <Printer className="w-4 h-4" />
            Generate PDF
          </button>
        </div>
      </aside>

      {/* Main Preview Area */}
      <main className="flex-1 flex flex-col bg-surface-100 relative order-1 md:order-2 h-[45vh] md:h-screen overflow-hidden">
        <header className="h-14 md:h-16 border-b border-surface-200 bg-white flex items-center justify-between px-4 md:px-8 absolute top-0 left-0 right-0 z-10 shadow-sm">
          <h2 className="text-base md:text-lg font-medium text-surface-900 flex items-center gap-2">
            Print Sheet Preview
            {isProcessing && <span className="flex h-2 w-2 relative ml-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-primary-500"></span>
            </span>}
          </h2>
          <div className="text-xs md:text-sm text-surface-700 flex gap-2 md:gap-4 bg-surface-50 px-2.5 py-1.5 md:px-3 md:py-1.5 rounded-lg border border-surface-200">
            <span>Size: <strong className="text-surface-900 font-semibold">{paperSize}</strong></span>
            <span className="border-l border-surface-200 pl-2 md:pl-4">Photos: <strong className="text-surface-900 font-semibold">{gridCount}</strong></span>
          </div>
        </header>

        <div className="flex-1 overflow-auto pt-14 md:pt-16 p-4 md:p-8 flex items-center justify-center bg-surface-100">
          {sourceImageObjectURL ? (
            <div className="relative shadow-2xl rounded-sm transition-all duration-300 bg-white" style={{
              width: paperSize === 'A4' ? (paperOrientation === 'portrait' ? '210mm' : '297mm') : (paperOrientation === 'portrait' ? '4in' : '6in'),
              height: paperSize === 'A4' ? (paperOrientation === 'portrait' ? '297mm' : '210mm') : (paperOrientation === 'portrait' ? '6in' : '4in'),
              aspectRatio: paperSize === 'A4' ? (paperOrientation === 'portrait' ? '210/297' : '297/210') : (paperOrientation === 'portrait' ? '4/6' : '6/4')
            }}>
              <canvas
                ref={canvasRef}
                className="w-full h-full object-contain rounded-sm bg-white"
                style={{ transformOrigin: 'top left' }}
              />
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center text-surface-400 p-12 border-2 border-dashed border-surface-200 rounded-2xl">
              <LayoutGrid className="w-16 h-16 mb-4 text-surface-300" />
              <p className="text-lg font-medium">No print preview available</p>
              <p className="text-sm mt-1 text-surface-400">Upload a photo to see the generated print sheet.</p>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

export default App;
