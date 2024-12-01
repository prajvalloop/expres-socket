


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
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});
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

  // Create a unique storage for each client
  let recordedChunks = [];
  let writeStream = null;

  socket.on('video-chunks', async (data) => {
    console.log('Video chunk is set');

    // Initialize writeStream when the first chunk arrives
    if (!writeStream) {
      writeStream = fs.createWriteStream('temp_upload/' + data.filename);
    }

    // Append the chunk to the file
    const buffer = Buffer.from(new Uint8Array(data.chunks));
    writeStream.write(buffer, (err) => {
      if (err) {
        console.error('Error writing chunk to file:', err);
      } else {
        console.log('Chunk saved');
      }
    });
  });

  socket.on('process-video', async (data) => {
    console.log('Processing', data);

    // Close the writeStream to ensure all data is flushed
    if (writeStream) {
      writeStream.end();
    }

    // Wait for the writeStream to finish
    writeStream.on('finish', async () => {
      fs.readFile('temp_upload/' + data.filename, async (err, file) => {
        if (err) {
          console.error('Error reading file:', err);
          return;
        }

        const processing = await axios.post(
          `${process.env.NEXT_API_HOST}recording/${data.userId}/processing`,
          { filename: data.filename }
        );
        if (processing.data.status !== 200)
          return console.log(
            'Error: Something went wrong with processing the file'
          );

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
          console.log('Video uploaded to AWS');
          if (processing.data.plan === 'PRO') {
            fs.stat('temp_upload/' + data.filename, async (err, stat) => {
              if (!err) {
                if (stat.size < 25000000) {
                  const transcription =
                    await openai.audio.transcriptions.create({
                      file: fs.createReadStream(
                        `temp_upload/${data.filename}`
                      ),
                      model: 'whisper-1',
                      response_format: 'text',
                    });
                  if (transcription) {
                    const completion =
                      await openai.chat.completions.create({
                        model: 'gpt-3.5-turbo',
                        messages: [
                          {
                            role: 'system',
                            content: `You are going to generate a title and a nice description using the speech to text transcription provided: transcription(${transcription}) and then return it in json format as {"title":<the title you gave>,"summary":<the summary you created>}`,
                          },
                        ],
                      });
                    console.log(
                      'gpt->response',
                      completion.choices[0].message.content
                    );
                    console.log(
                      'gpt->whisper->response',
                      transcription
                    );
                    const titleAndSummary = await axios.post(
                      `${process.env.NEXT_API_HOST}recording/${data.userId}/transcribe`,
                      {
                        filename: data.filename,
                        content: completion.choices[0].message.content,
                        transcript: transcription,
                      }
                    );
                    if (titleAndSummary.data.status !== 200) {
                      console.log(
                        'Error: Something went wrong when creating the title and description'
                      );
                    }
                  }
                }
              }
            });
          }
          const stopProcessing = await axios.post(
            `${process.env.NEXT_API_HOST}recording/${data.userId}/complete`,
            {
              filename: data.filename,
            }
          );
          if (stopProcessing.data.status !== 200) {
            console.log(
              'Error: Something went wrong when stopping the processing stage.'
            );
          }
          if (stopProcessing.data.status === 200) {
            fs.unlink('temp_upload/' + data.filename, (err) => {
              if (!err)
                console.log(data.filename + ' deleted successfully');
            });
          }
        } else {
          console.log('Error: Upload failed, process aborted');
        }
      });
    });
  });

  socket.on('disconnect', async (data) => {
    console.log('Socket.id is disconnected', socket.id);
  });
});

server.listen(5000, () => {
  console.log('Listening to port 5000');
});
