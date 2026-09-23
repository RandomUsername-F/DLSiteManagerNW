// system/image-downloader.js
// Downloads a game's cover/sample images from the remote URLs
// system/dlsite_parser.js returns (info.images: {thumbUrl, galleryUrls}),
// saving them under Database/Games/DLsite/<code>/images/ as thumb.jpg,
// 001.jpg, 002.jpg, ... - the local, relative-path convention every other
// part of the app (system/table.js, system/edit-panel.js) already expects
// via a game record's images.thumb / images.gallery fields.
//
// Meant to run right after dlsite_parser.js's info parse, via
// system/library-import.js's applyParsedInfo() - but kept as its own
// module/function on purpose, so it can also be called on its own later
// (e.g. a "re-download images" action) without re-parsing the whole page.
//
// GUARDS, consistent with dlsite_parser.js:
// - Never overwrites a game's existing local images with a failed
//   download: each file downloads independently, and only the ones that
//   actually succeed are reflected in the result; a failed one falls
//   back to whatever was already there (existingImages), rather than
//   being replaced with nothing.
// - Half-written files are never left looking "done": each download
//   writes to a temporary "<name>.jpg.part" file first, and only renames
//   it to the real filename after a full, successful write - so a
//   connection drop mid-download can't leave a corrupt thumb.jpg in
//   place of a previously-good one.
// - Images are saved by content, not assumed format: DLsite currently
//   only serves .jpg for these (confirmed against a real product page),
//   so filenames are hardcoded as thumb.jpg/NNN.jpg to match this app's
//   established naming convention. If DLsite ever serves a different
//   format for one of these, the bytes would still be saved correctly,
//   but the .jpg extension would be misleading - flagged here rather
//   than silently assumed handled, since this project has no image
//   library to actually detect/transcode formats.

const https = require('https');
const { URL } = require('url'); // explicit require rather than the bare global - see system/dom-bridge.js for why bare globals aren't trusted in this environment
const fs = require('fs');
const path = require('path');

const GAMES_ROOT = path.join(__dirname, '..', 'Database', 'Games', 'DLsite');

/**
 * downloadGameImages(productCode, remoteImages, existingImages?)
 *   remoteImages: { thumbUrl, galleryUrls } - as returned by
 *     dlsite_parser.js's extractImages().
 *   existingImages: the game's current { thumb, gallery } (local paths),
 *     if any - used as the fallback for anything that fails to download.
 * Returns the new { thumb, gallery } (local relative paths) reflecting
 * only what actually downloaded successfully, merged over
 * existingImages - or null if there was nothing to download and nothing
 * existing to fall back to.
 */
async function downloadGameImages(productCode, remoteImages, existingImages) {
  if (!remoteImages) return existingImages || null;

  const imagesDir = path.join(GAMES_ROOT, productCode, 'images');
  fs.mkdirSync(imagesDir, { recursive: true });

  const result = {
    thumb: existingImages ? existingImages.thumb : null,
    gallery: existingImages ? (existingImages.gallery || []).slice() : []
  };

  if (remoteImages.thumbUrl) {
    const ok = await downloadOne(remoteImages.thumbUrl, path.join(imagesDir, 'thumb.jpg'));
    if (ok) result.thumb = 'images/thumb.jpg';
  }

  if (Array.isArray(remoteImages.galleryUrls) && remoteImages.galleryUrls.length) {
    const newGallery = [];
    for (let i = 0; i < remoteImages.galleryUrls.length; i++) {
      const filename = String(i + 1).padStart(3, '0') + '.jpg';
      const ok = await downloadOne(remoteImages.galleryUrls[i], path.join(imagesDir, filename));
      if (ok) newGallery.push('images/' + filename);
    }
    // Only replace the gallery list if at least one new image actually
    // came down - otherwise keep whatever was there before.
    if (newGallery.length) result.gallery = newGallery;
  }

  if (!result.thumb && result.gallery.length === 0) return null;
  return result;
}

/**
 * Downloads one URL to one file, following redirects itself. Resolves
 * true/false rather than throwing/rejecting, so one failed image can
 * never abort the rest of the batch in downloadGameImages().
 */
function downloadOne(url, destPath, maxRedirects) {
  if (maxRedirects === undefined) maxRedirects = 5;

  return new Promise((resolve) => {
    function get(currentUrl, redirectsLeft) {
      const req = https.get(currentUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
        const statusCode = res.statusCode;

        if ([301, 302, 303, 307, 308].includes(statusCode) && res.headers.location) {
          res.resume();
          if (redirectsLeft <= 0) {
            console.error('image-downloader: too many redirects fetching', url);
            resolve(false);
            return;
          }
          const nextUrl = new URL(res.headers.location, currentUrl).toString();
          get(nextUrl, redirectsLeft - 1);
          return;
        }

        if (statusCode !== 200) {
          res.resume();
          console.error(`image-downloader: HTTP ${statusCode} fetching ${currentUrl}`);
          resolve(false);
          return;
        }

        const tmpPath = destPath + '.part';
        const fileStream = fs.createWriteStream(tmpPath);
        res.pipe(fileStream);

        fileStream.on('finish', () => {
          fileStream.close(() => {
            try {
              fs.renameSync(tmpPath, destPath); // only becomes the "real" file once fully written
              resolve(true);
            } catch (e) {
              console.error('image-downloader: failed to finalize', destPath, e);
              resolve(false);
            }
          });
        });

        fileStream.on('error', (e) => {
          console.error('image-downloader: write failed for', destPath, e);
          try { fs.unlinkSync(tmpPath); } catch (cleanupErr) { /* best-effort cleanup */ }
          resolve(false);
        });

        res.on('error', (e) => {
          console.error('image-downloader: download stream failed for', url, e);
          try { fileStream.destroy(); } catch (destroyErr) { /* best-effort cleanup */ }
          try { fs.unlinkSync(tmpPath); } catch (cleanupErr) { /* best-effort cleanup */ }
          resolve(false);
        });
      });

      req.on('error', (e) => {
        console.error('image-downloader: request failed for', url, e);
        resolve(false);
      });
    }

    get(url, maxRedirects);
  });
}

module.exports = { downloadGameImages };
