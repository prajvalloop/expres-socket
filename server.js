const cors = require('cors');
const express = require('express');
const app = express();
const http = require('http');
const { Server } = require('socket.io');
const dotenv = require('dotenv');
const axios = require('axios');
const fs = require('fs');
const { Readable } = require('stream');
const OpenAI = require('openai');
const { PutObjectCommand, S3Client } = require('@aws-sdk/client-s3');

dotenv.config();

const s3 = new S3Client({
  credentials: {
    accessKeyId: process.env.ACCESS_KEY,
    secretAccessKey: process.env.SECRET_KEY,
  },
  region: process.env.BUCKET_REGION,
});

app.use(cors());
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: process.env.ELECTRON_HOST,
    methods: ['GET', 'POST'],
  },
});

io.on('connection', (socket) => {
  console.log('Socket is connected');

  let writeStream = null;

  socket.on('video-chunks', (data) => {
    console.log('Video chunk received');

    if (!writeStream) {
      writeStream = fs.createWriteStream(`temp_upload/${data.filename}`);
    }

    const buffer = Buffer.from(new Uint8Array(data.chunks));

    if (writeStream.writable) {
      writeStream.write(buffer, (err) => {
        if (err) {
          console.error('Error writing chunk to file:', err);
        } else {
          console.log('Chunk saved successfully');
        }
      });
    } else {
      console.error('Cannot write chunk: Write stream is not writable');
    }
  });

  socket.on('process-video', async (data) => {
    console.log('Processing video:', data);
    const openai = new OpenAI({ apiKey: data.API_KEY });

    if (writeStream) {
      writeStream.end();
      writeStream = null;
    }

    fs.readFile(`temp_upload/${data.filename}`, async (err, file) => {
      if (err) {
        console.error('Error reading file:', err);
        return;
      }

      try {
        const processing = await axios.post(
          `${process.env.NEXT_API_HOST}recording/${data.userId}/processing`,
          { filename: data.filename }
        );

        if (processing.data.status !== 200) {
          console.error('Error during processing stage');
          return;
        }

        const Key = data.filename;
        const Bucket = process.env.BUCKET_NAME;
        const ContentType = 'video/webm';

        const command = new PutObjectCommand({
          Key,
          Bucket,
          ContentType,
          Body: file,
        });

        const fileStatus = await s3.send(command);
        if (fileStatus['$metadata'].httpStatusCode === 200) {
          console.log('Video uploaded to AWS successfully');

          if (processing.data.plan === 'PRO') {
            const stat = fs.statSync(`temp_upload/${data.filename}`);
            if (stat.size < 25000000) {
              try {
                const transcription = await openai.audio.transcriptions.create({
                  file: fs.createReadStream(`temp_upload/${data.filename}`),
                  model: 'whisper-1',
                  response_format: 'text',
                });

                const completion = await openai.chat.completions.create({
                  model: 'gpt-3.5-turbo',
                  messages: [
                    {
                      role: 'system',
                      content: `Generate a title and description using this transcription: transcription(${transcription}). Return JSON as {"title":<title>, "summary":<summary>}`,
                    },
                  ],
                });

                const titleAndSummary = await axios.post(
                  `${process.env.NEXT_API_HOST}recording/${data.userId}/transcribe`,
                  {
                    filename: data.filename,
                    content: completion.choices[0].message.content,
                    transcript: transcription,
                  }
                );

                if (titleAndSummary.data.status !== 200) {
                  console.error('Error creating title and summary');
                }
              } catch (error) {
                console.error('Error with OpenAI API:');
              }
            }
          }

          const stopProcessing = await axios.post(
            `${process.env.NEXT_API_HOST}recording/${data.userId}/complete`,
            { filename: data.filename }
          );

          if (stopProcessing.data.status === 200) {
            fs.unlink(`temp_upload/${data.filename}`, (err) => {
              if (!err) {
                console.log(`${data.filename} deleted successfully`);
              }
            });
          } else {
            console.error('Error during stop processing stage');
          }
        } else {
          console.error('Error: Upload to AWS failed');
        }
      } catch (error) {
        console.error('Error during processing:', error);
      }
    });
  });

  socket.on('disconnect', () => {
    console.log('Socket disconnected:', socket.id);

    if (writeStream) {
      writeStream.end();
      writeStream = null;
    }
  });
});

server.listen(5000, () => {
  console.log('Server is listening on port 5000');
});
