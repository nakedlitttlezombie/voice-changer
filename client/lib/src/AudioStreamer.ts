import { io, Socket } from "socket.io-client";
import { DefaultEventsMap } from "@socket.io/component-emitter";
import { Duplex, DuplexOptions } from "readable-stream";
import { DefaultVoiceChangerClientSetting, DownSamplingMode, Protocol, SendingSampleRate, VoiceChangerMode, VOICE_CHANGER_CLIENT_EXCEPTION } from "./const";


export type Callbacks = {
    onVoiceReceived: (voiceChangerMode: VoiceChangerMode, data: ArrayBuffer) => void
}
export type AudioStreamerListeners = {
    notifySendBufferingTime: (time: number) => void
    notifyResponseTime: (time: number) => void
    notifyException: (code: VOICE_CHANGER_CLIENT_EXCEPTION, message: string) => void
}

export type AudioStreamerSettings = {
    serverUrl: string;
    protocol: Protocol;
    inputChunkNum: number;
    voiceChangerMode: VoiceChangerMode;
}


export class AudioStreamer extends Duplex {
    private callbacks: Callbacks
    private audioStreamerListeners: AudioStreamerListeners
    private protocol: Protocol = "sio"
    private serverUrl = ""
    private socket: Socket<DefaultEventsMap, DefaultEventsMap> | null = null
    private voiceChangerMode: VoiceChangerMode = "realtime"
    private inputChunkNum = 128
    private requestChunks: ArrayBuffer[] = []
    private recordChunks: ArrayBuffer[] = []
    private isRecording = false

    // performance monitor
    private bufferStart = 0;

    // Flags 
    // private downSamplingMode: DownSamplingMode = DownSamplingMode.decimate
    private downSamplingMode: DownSamplingMode = DownSamplingMode.average
    private sendingSampleRate: number = DefaultVoiceChangerClientSetting.sendingSampleRate

    constructor(callbacks: Callbacks, audioStreamerListeners: AudioStreamerListeners, options?: DuplexOptions) {
        super(options);
        this.callbacks = callbacks
        this.audioStreamerListeners = audioStreamerListeners
    }

    private createSocketIO = () => {
        if (this.socket) {
            this.socket.close()
        }
        if (this.protocol === "sio") {
            this.socket = io(this.serverUrl + "/test");
            this.socket.on('connect_error', (err) => {
                this.audioStreamerListeners.notifyException(VOICE_CHANGER_CLIENT_EXCEPTION.ERR_SIO_CONNECT_FAILED, `[SIO] rconnection failed ${err}`)
            })
            this.socket.on('connect', () => {
                console.log(`[SIO] sonnect to ${this.serverUrl}`)
                console.log(`[SIO] ${this.socket?.id}`)
            });
            this.socket.on('response', (response: any[]) => {
                const cur = Date.now()
                const responseTime = cur - response[0]
                const result = response[1] as ArrayBuffer
                if (result.byteLength < 128 * 2) {
                    this.audioStreamerListeners.notifyException(VOICE_CHANGER_CLIENT_EXCEPTION.ERR_SIO_INVALID_RESPONSE, `[SIO] recevied data is too short ${result.byteLength}`)
                } else {
                    this.callbacks.onVoiceReceived(this.voiceChangerMode, response[1])
                    this.audioStreamerListeners.notifyResponseTime(responseTime)
                }
            });
        }
    }

    // Option Change
    setServerUrl = (serverUrl: string) => {
        this.serverUrl = serverUrl
        console.log(`[AudioStreamer] Server Setting:${this.serverUrl} ${this.protocol}`)
        this.createSocketIO()// mode check is done in the method.
    }
    setProtocol = (mode: Protocol) => {
        this.protocol = mode
        console.log(`[AudioStreamer] Server Setting:${this.serverUrl} ${this.protocol}`)
        this.createSocketIO()// mode check is done in the method.
    }

    setInputChunkNum = (num: number) => {
        this.inputChunkNum = num
    }

    setVoiceChangerMode = (val: VoiceChangerMode) => {
        this.voiceChangerMode = val
    }

    // set Flags
    setDownSamplingMode = (val: DownSamplingMode) => {
        this.downSamplingMode = val
    }
    setSendingSampleRate = (val: SendingSampleRate) => {
        this.sendingSampleRate = val
    }

    getSettings = (): AudioStreamerSettings => {
        return {
            serverUrl: this.serverUrl,
            protocol: this.protocol,
            inputChunkNum: this.inputChunkNum,
            voiceChangerMode: this.voiceChangerMode
        }
    }

    getSocketId = () => {
        return this.socket?.id
    }



    // Main Process
    //// Pipe from mic stream 
    _write = (chunk: AudioBuffer, _encoding: any, callback: any) => {
        const buffer = chunk.getChannelData(0);
        // console.log("SAMPLERATE:", chunk.sampleRate, chunk.numberOfChannels, chunk.length, buffer)
        if (this.voiceChangerMode === "realtime") {
            this._write_realtime(buffer)
        } else {
            this._write_record(buffer)
        }
        callback();
    }

    _averageDownsampleBuffer(buffer: Float32Array, originalSampleRate: number, destinationSamplerate: number) {
        if (originalSampleRate == destinationSamplerate) {
            return buffer;
        }
        if (destinationSamplerate > originalSampleRate) {
            throw "downsampling rate show be smaller than original sample rate";
        }
        const sampleRateRatio = originalSampleRate / destinationSamplerate;
        const newLength = Math.round(buffer.length / sampleRateRatio);
        const result = new Float32Array(newLength);
        let offsetResult = 0;
        let offsetBuffer = 0;
        while (offsetResult < result.length) {
            var nextOffsetBuffer = Math.round((offsetResult + 1) * sampleRateRatio);
            // Use average value of skipped samples
            var accum = 0, count = 0;
            for (var i = offsetBuffer; i < nextOffsetBuffer && i < buffer.length; i++) {
                accum += buffer[i];
                count++;
            }
            result[offsetResult] = accum / count;
            // Or you can simply get rid of the skipped samples:
            // result[offsetResult] = buffer[nextOffsetBuffer];
            offsetResult++;
            offsetBuffer = nextOffsetBuffer;
        }
        return result;
    }


    private _write_realtime = async (buffer: Float32Array) => {

        let downsampledBuffer: Float32Array | null = null
        if (this.sendingSampleRate == 48000) {
            downsampledBuffer = buffer
        } else if (this.downSamplingMode == DownSamplingMode.decimate) {
            //////// (Kind 1) 間引き //////////
            // bufferSize個のデータ（48Khz）が入ってくる。
            //// 48000Hz で入ってくるので間引いて24000Hzに変換する。
            downsampledBuffer = new Float32Array(buffer.length / 2);
            for (let i = 0; i < buffer.length; i++) {
                if (i % 2 == 0) {
                    downsampledBuffer[i / 2] = buffer[i]
                }
            }
        } else {
            //////// (Kind 2) 平均 //////////
            // downsampledBuffer = this._averageDownsampleBuffer(buffer, 48000, 24000)
            downsampledBuffer = this._averageDownsampleBuffer(buffer, 48000, this.sendingSampleRate)
        }

        // Float to signed16
        const arrayBuffer = new ArrayBuffer(downsampledBuffer.length * 2)
        const dataView = new DataView(arrayBuffer);
        for (let i = 0; i < downsampledBuffer.length; i++) {
            let s = Math.max(-1, Math.min(1, downsampledBuffer[i]));
            s = s < 0 ? s * 0x8000 : s * 0x7FFF
            dataView.setInt16(i * 2, s, true);
        }


        // 256byte(最低バッファサイズ256から間引いた個数x2byte)をchunkとして管理
        // const chunkByteSize = 256 // (const.ts ★1)
        // const chunkByteSize = 256 * 2 // (const.ts ★1)
        const chunkByteSize = (256 * 2) * (this.sendingSampleRate / 48000) // (const.ts ★1)
        for (let i = 0; i < arrayBuffer.byteLength / chunkByteSize; i++) {
            const ab = arrayBuffer.slice(i * chunkByteSize, (i + 1) * chunkByteSize)
            this.requestChunks.push(ab)
        }


        //// リクエストバッファの中身が、リクエスト送信数と違う場合は処理終了。
        if (this.requestChunks.length < this.inputChunkNum) {
            return
        }

        // リクエスト用の入れ物を作成
        const windowByteLength = this.requestChunks.reduce((prev, cur) => {
            return prev + cur.byteLength
        }, 0)
        const newBuffer = new Uint8Array(windowByteLength);

        // リクエストのデータをセット
        this.requestChunks.reduce((prev, cur) => {
            newBuffer.set(new Uint8Array(cur), prev)
            return prev + cur.byteLength
        }, 0)

        // console.log("send buff length", newBuffer.length)

        this.sendBuffer(newBuffer)
        this.requestChunks = []

        this.audioStreamerListeners.notifySendBufferingTime(Date.now() - this.bufferStart)
        this.bufferStart = Date.now()
    }


    private _write_record = (buffer: Float32Array) => {
        if (!this.isRecording) { return }
        // buffer(for48Khz)x16bit * chunksize / 2(for24Khz)
        const sendBuffer = new ArrayBuffer(buffer.length * 2 / 2);
        const sendDataView = new DataView(sendBuffer);
        for (var i = 0; i < buffer.length; i++) {
            if (i % 2 == 0) {
                let s = Math.max(-1, Math.min(1, buffer[i]));
                s = s < 0 ? s * 0x8000 : s * 0x7FFF
                sendDataView.setInt16(i, s, true);
                // if (i % 3000 === 0) {
                //     console.log("buffer_converting", s, buffer[i])
                // }
            }
        }
        this.recordChunks.push(sendBuffer)
    }

    // Near Realtime用のトリガ
    sendRecordedData = () => {
        const length = this.recordChunks.reduce((prev, cur) => {
            return prev + cur.byteLength
        }, 0)
        const newBuffer = new Uint8Array(length);
        this.recordChunks.reduce((prev, cur) => {
            newBuffer.set(new Uint8Array(cur), prev)
            return prev + cur.byteLength
        }, 0)

        this.sendBuffer(newBuffer)
    }

    startRecord = () => {
        this.recordChunks = []
        this.isRecording = true
    }

    stopRecord = () => {
        this.isRecording = false
    }

    private sendBuffer = async (newBuffer: Uint8Array) => {
        const timestamp = Date.now()
        if (this.protocol === "sio") {
            if (!this.socket) {
                console.warn(`sio is not initialized`)
                return
            }
            // console.log("emit!")
            this.socket.emit('request_message', [
                timestamp,
                newBuffer.buffer]);
        } else {
            const res = await postVoice(
                this.serverUrl + "/test",
                timestamp,
                newBuffer.buffer)

            if (res.byteLength < 128 * 2) {
                this.audioStreamerListeners.notifyException(VOICE_CHANGER_CLIENT_EXCEPTION.ERR_REST_INVALID_RESPONSE, `[REST] recevied data is too short ${res.byteLength}`)
            } else {
                this.callbacks.onVoiceReceived(this.voiceChangerMode, res)
                this.audioStreamerListeners.notifyResponseTime(Date.now() - timestamp)
            }
        }
    }
}

export const postVoice = async (
    url: string,
    timestamp: number,
    buffer: ArrayBuffer) => {
    const obj = {
        timestamp,
        buffer: Buffer.from(buffer).toString('base64')
    };
    const body = JSON.stringify(obj);

    const res = await fetch(`${url}`, {
        method: "POST",
        headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json'
        },
        body: body
    })

    const receivedJson = await res.json()
    const changedVoiceBase64 = receivedJson["changedVoiceBase64"]
    const buf = Buffer.from(changedVoiceBase64, "base64")
    const ab = new ArrayBuffer(buf.length);
    const view = new Uint8Array(ab);
    for (let i = 0; i < buf.length; ++i) {
        view[i] = buf[i];
    }
    return ab
}