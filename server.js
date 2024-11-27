const cors=require('cors')
const express=require('express')
const http=require('http')
const {Server}=require('socket.io')
const dotenv=require('dotenv')
const fs=require('fs')
const { Readable } = require('stream')
const app=express()
app.use(cors())
dotenv.config()
const server=http.createServer(app)

const io=new Server(server,{
    cors:{
        origin:process.env.ELECTRON_HOST,
        methods:['GET','POST']
    }
})
let recordedChunks=[]
io.on('connection',(socket)=>{
    console.log('Socket is connected')
    socket.on("video-chunks",async(data)=>{
        console.log('Video chunk is set')
        const writestream=fs.createWriteStream('temp_upload/'+data.filename)
        recordedChunks.push(data.chunks)
        const videoBlob=new Blob(recordedChunks,{
            type:'video/webm; codecs=vp9',
        })
        const buffer=Buffer.from(await videoBlob.arrayBuffer())
        const readStream=Readable.from(buffer)
        readStream.pipe(writestream).on("finish",()=>{
            console.log("Chunk saved")
        })
    })

    socket.on("process-video",async(data)=>{
        console.log('Processing',data)

    })
    socket.on("disconnect",async(data)=>{
        console.log('Socket.id is disconnected',socket.id)

    })
})

server.listen(5000,()=>{
    console.log('Listing to port 5000')
})
