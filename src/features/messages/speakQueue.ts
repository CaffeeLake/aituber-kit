import { Talk } from './messages'
import homeStore from '@/features/stores/home'
import settingsStore from '@/features/stores/settings'
import { Live2DHandler } from './live2dHandler'

type SpeakTask = {
  sessionId: string
  audioBuffer: ArrayBuffer
  talk: Talk
  isNeedDecode: boolean
  onComplete?: () => void
}

export class SpeakQueue {
  private static readonly QUEUE_CHECK_DELAY = 1500
  private queue: SpeakTask[] = []
  private isProcessing = false
  private currentSessionId: string | null = null
  private static speakCompletionCallbacks: (() => void)[] = []
  private static _instance: SpeakQueue | null = null
  private stopped = false
  private static stopTokenCounter = 0

  public static get currentStopToken() {
    return SpeakQueue.stopTokenCounter
  }

  // 発話完了時のコールバックを登録
  static onSpeakCompletion(callback: () => void) {
    SpeakQueue.speakCompletionCallbacks.push(callback)
  }

  // 発話完了時のコールバックを削除
  static removeSpeakCompletionCallback(callback: () => void) {
    SpeakQueue.speakCompletionCallbacks =
      SpeakQueue.speakCompletionCallbacks.filter((cb) => cb !== callback)
  }

  /**
   * キューのグローバルインスタンスを取得します。
   */
  public static getInstance(): SpeakQueue {
    if (!SpeakQueue._instance) {
      SpeakQueue._instance = new SpeakQueue()
    }
    return SpeakQueue._instance
  }

  /**
   * すべての発話を停止し、キューをクリアします。
   * Stop ボタンから呼び出されます。
   */
  public static stopAll() {
    const instance = SpeakQueue.getInstance()
    instance.stopped = true
    // 発話キューの処理状態をリセットして次回の再生を可能にする
    instance.isProcessing = false
    SpeakQueue.stopTokenCounter++
    instance.clearQueue()
    const hs = homeStore.getState()
    const ss = settingsStore.getState()
    if (ss.modelType === 'live2d') {
      Live2DHandler.stopSpeaking()
    } else {
      hs.viewer.model?.stopSpeaking()
    }
    homeStore.setState({ isSpeaking: false })
  }

  async addTask(task: SpeakTask) {
    this.queue.push(task)
    // キューにタスクが追加された時点で発話中フラグを立てる
    homeStore.setState({ isSpeaking: true })
    await this.processQueue()
  }

  private async processQueue() {
    if (this.isProcessing) return

    // 停止中は処理しない
    if (this.stopped) {
      this.clearQueue()
      return
    }

    this.isProcessing = true
    const hs = homeStore.getState()
    const ss = settingsStore.getState()

    // isSpeaking はループ内部で最新値を参照するため、ここでは条件に含めない
    while (this.queue.length > 0) {
      const currentState = homeStore.getState()
      if (!currentState.isSpeaking) {
        this.clearQueue()
        homeStore.setState({ isSpeaking: false })
        break
      }

      const task = this.queue.shift()
      if (task) {
        if (task.sessionId !== this.currentSessionId) {
          // 旧セッションのタスクは破棄
          continue
        }
        try {
          const { audioBuffer, talk, isNeedDecode, onComplete } = task
          if (ss.modelType === 'live2d') {
            await Live2DHandler.speak(audioBuffer, talk, isNeedDecode)
          } else {
            await hs.viewer.model?.speak(audioBuffer, talk, isNeedDecode)
          }
          onComplete?.()
        } catch (error) {
          console.error(
            'An error occurred while processing the speech synthesis task:',
            error
          )
          if (error instanceof Error) {
            console.error('Error details:', error.message)
          }
        }
      }
    }

    this.isProcessing = false
    this.scheduleNeutralExpression()
    if (!hs.chatProcessing) {
      this.clearQueue()
    }
  }

  private async scheduleNeutralExpression() {
    const initialLength = this.queue.length
    await new Promise((resolve) =>
      setTimeout(resolve, SpeakQueue.QUEUE_CHECK_DELAY)
    )

    if (this.shouldResetToNeutral(initialLength)) {
      const hs = homeStore.getState()
      const ss = settingsStore.getState()
      if (ss.modelType === 'live2d') {
        await Live2DHandler.resetToIdle()
      } else {
        await hs.viewer.model?.playEmotion('neutral')
      }
    }
  }

  private shouldResetToNeutral(initialLength: number): boolean {
    const isComplete =
      initialLength === 0 && this.queue.length === 0 && !this.isProcessing

    // 発話完了時にコールバックを呼び出す
    if (isComplete) {
      console.log('🎤 発話が完了しました。登録されたコールバックを実行します。')
      // 発話完了時に isSpeaking を必ず false に設定
      homeStore.setState({ isSpeaking: false })
      // 停止フラグもリセットして次回の動作に備える
      this.stopped = false
      // すべての発話完了コールバックを呼び出す
      SpeakQueue.speakCompletionCallbacks.forEach((callback) => {
        try {
          callback()
        } catch (error) {
          console.error(
            '発話完了コールバックの実行中にエラーが発生しました:',
            error
          )
        }
      })
    }

    return isComplete
  }

  clearQueue() {
    this.queue = []
  }

  checkSessionId(sessionId: string) {
    // 停止中の場合はセッションIDに関わらず再開する
    if (this.stopped) {
      this.currentSessionId = sessionId
      // 念のためキューをクリア（Stop 時点で空だが保険）
      this.clearQueue()
      this.stopped = false
      homeStore.setState({ isSpeaking: true })
      return
    }

    // 通常時にセッションIDが変わった場合はキューをリセット
    if (this.currentSessionId !== sessionId) {
      this.currentSessionId = sessionId
      this.clearQueue()
      homeStore.setState({ isSpeaking: true })
    }
  }

  // インスタンスが停止状態かどうか
  public isStopped(): boolean {
    return this.stopped
  }
}
