package worker

import (
	"context"
	"sync"

	"github.com/sujal/go-scraper/internal/types"
)

// Pool coordinates concurrent goroutine workers processing scrape jobs from a buffered channel
type Pool struct {
	workers   int
	jobCh     chan types.Job
	resultCh  chan types.WorkerResult
	wg        sync.WaitGroup
	processFn func(context.Context, types.Job) types.WorkerResult
}

// New creates a new WorkerPool
func New(workers int, processFn func(context.Context, types.Job) types.WorkerResult) *Pool {
	if workers <= 0 {
		workers = 10
	}
	return &Pool{
		workers:   workers,
		jobCh:     make(chan types.Job, workers*10),
		resultCh:  make(chan types.WorkerResult, workers*10),
		processFn: processFn,
	}
}

// Start launches N worker goroutines
func (p *Pool) Start(ctx context.Context) {
	for i := 0; i < p.workers; i++ {
		p.wg.Add(1)
		go func() {
			defer p.wg.Done()
			for {
				select {
				case <-ctx.Done():
					return
				case job, ok := <-p.jobCh:
					if !ok {
						return
					}
					res := p.processFn(ctx, job)
					select {
					case <-ctx.Done():
						return
					case p.resultCh <- res:
					}
				}
			}
		}()
	}
}

// Submit enqueues a job into the worker pool
func (p *Pool) Submit(job types.Job) {
	p.jobCh <- job
}

// Results returns the output channel for processed results
func (p *Pool) Results() <-chan types.WorkerResult {
	return p.resultCh
}

// Close gracefully waits for workers to finish and closes output channel
func (p *Pool) Close() {
	close(p.jobCh)
	p.wg.Wait()
	close(p.resultCh)
}
