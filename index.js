const fs = require('fs');
const path = require('path');
const co = require('co');
const { exec, spawn } = require('child_process');
const ProgressPromise = require('progress-promise');

const getMetaData = inputFilePath => new Promise((resolve, reject) => {
  exec(`ffmpeg -hide_banner -i ${inputFilePath}`, (err, stderr, stdout) => {
    const metaData = {
      duration: null,
      width: null,
      height: null,
      fps: null,
      rotate: null,
      hasAudio: /Stream.+Audio/.test(stdout),
    };

    let rotate = 0;
    let tmpWidth = null;
    let tmpHeight = null;

    stdout.split(/[\n\r]/g).filter(line => /^(Duration|Stream.+Video|rotate)/.test(line.trim())).forEach((l) => {
      const line = l.trim();

      if (/^Duration/.test(line)) {
        metaData.duration = line.match(/^Duration: (.+?),/)[1].split(':').reduce((preview, current, index) => (+current * (60 ** (2 - index))) + preview, 0);
      } else if (/^rotate/.test(line)) {
        rotate = +line.split(':')[1];
      } else {
        const tmp = line.replace(/\(.+?\)/g, '').split(',');
        const size = tmp[2].trim().split(' ')[0].split('x');
        tmpWidth = +size[0];
        tmpHeight = +size[1];
        const fpsText = tmp.find(t => /fps/.test(t));
        metaData.fps = fpsText ? +fpsText.trim().split(' ')[0] : 30;
      }
    });

    metaData.rotate = rotate;

    if (rotate % 180 === 0) {
      metaData.width = tmpWidth;
      metaData.height = tmpHeight;
    } else {
      metaData.width = tmpHeight;
      metaData.height = tmpWidth;
    }

    if (metaData.duration > 0) resolve(metaData);
    else reject(new Error('Invalid data.'));
  });
});

module.exports = {
  getMetaData,
  createInfo({ cid, length, aspect, audioIndex }) {
    return {
      cid,
      audio: audioIndex || 0,
      srcset: new Array(length),
      aspect,
    };
  },
  transcode: ({ inputFile, outputDir, originId, metaData, quality, option }) => new ProgressPromise((resolve, reject, progress) => {
    co(function* () {
      const { width, height, duration, fps, hasAudio, rotate } = metaData || (yield getMetaData(inputFile));
      const MAX_LENGTH = quality || Math.max(width, height);

      function convert(resolveConverter, rejectConverter, type, command, frameCount) {
        const convertPath = path.join(outputDir, originId, type);
        if (!fs.existsSync(convertPath)) fs.mkdirSync(convertPath, '0777');

        const transVideo = spawn('ffmpeg', command, { cwd: option && option.cwd });
        transVideo.stderr.setEncoding('utf8');
        transVideo.stderr.on('data', (data) => {
          if (/^frame=/.test(data)) {
            progress({
              type,
              ratio: Math.min(0.999, +data.match(/^frame=.+?(\d+)/)[1] / frameCount),
            });
          }
        });

        transVideo.on('error', (err) => {
          rejectConverter(err);
        });

        transVideo.on('close', () => {
          progress({
            type,
            ratio: 1,
          });
          resolveConverter();
        });
      }

      const outputPath = path.join(outputDir, originId);
      if (!fs.existsSync(outputPath)) fs.mkdirSync(outputPath, '0777');

      if (hasAudio && (!option || option.audio !== false)) {
        yield new Promise((resolveConverter, rejectConverter) => {
          convert(resolveConverter, rejectConverter, 'audio', ['-i', inputFile, '-ab', '128k', path.join(outputPath, 'audio/audio.mp3')], duration * fps);
        });
      }

      const transpose = rotate === 0 ? '' : rotate === 180 ? 'vflip,' : `transpose=${rotate === 90 ? 1 : 2},`;
      yield new Promise((resolveConverter, rejectConverter) => {
        convert(resolveConverter, rejectConverter, 'image', ['-i', inputFile, '-q:v', 5, '-r', fps, '-threads', 0, '-vf', `${transpose}scale=w=${MAX_LENGTH}:h=${MAX_LENGTH}:force_original_aspect_ratio=decrease`, path.join(outputPath, 'image/%d.jpg')], duration * fps);
      });

      resolve([
        originId,
        metaData.duration,
        fs.readdirSync(path.join(outputPath, 'image')).length,
      ]);
    });
  }),
};
